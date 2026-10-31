import { afterEach, describe, expect, it } from 'vitest';
import { runEmbed, type EmbedLoopRequest } from '../src/embed.js';
import type { Adapter } from '../src/adapters/types.js';
import { AdapterError } from '../src/errors.js';
import { createLlm, FAILURE_MESSAGES } from '../src/index.js';
import { createLlmWithEndpoints, resetCapabilityOverrides } from '../testing/index.js';
import { config, operation } from './helpers.js';
import { openaiEmbeddings } from '../testing/stubs/openai.js';
import { startStub } from '../testing/stubs/server.js';

afterEach(() => resetCapabilityOverrides());

type Embedded = { vectors: number[][]; inputTokens?: number };
type Step = Embedded | AdapterError | (() => Promise<Embedded>);

function scripted(...steps: Step[]) {
  const calls: string[][] = [];
  const adapter: Adapter = {
    generateOnce: () => Promise.reject(new Error('not used')),
    async embedBatch(texts) {
      calls.push([...texts]);
      const step = steps.shift();
      if (step === undefined) throw new Error('script is empty');
      if (step instanceof AdapterError) throw step;
      if (typeof step === 'function') return step();
      return step;
    },
  };
  return { adapter, calls };
}

const deps = (waits: number[] = []) => ({ sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); }, random: () => 0 });
const request = (over: Partial<EmbedLoopRequest> = {}): EmbedLoopRequest => ({ provider: 'gemini', model: 'm', texts: ['a', 'b'], batchSize: 100, timeoutMs: 60_000, ...over });

describe('embed without a configured provider', () => {
  it('fails at once as not_configured, with a zero-attempt usage record, loading nothing', async () => {
    const lines: string[] = [];
    const result = await createLlm(config(), { log: (l) => lines.push(l) }).embed({ texts: ['a'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ category: 'not_configured', message: FAILURE_MESSAGES.not_configured });
    expect(result.usage).toMatchObject({ operation: 'embed', provider: null, outcome: 'not_configured', attempts: 0, temperatureApplied: null });
    expect(lines).toHaveLength(1);
  });
});

describe('argument checks', () => {
  const llm = createLlm(config({ embedding: operation('gemini', { model: 'm' }) }));

  it.each([[[]], [['']], [['ok', '']], [Array.from({ length: 1001 }, () => 'x')]])('refuses %#', async (texts) => {
    await expect(llm.embed({ texts })).rejects.toThrow(RangeError);
  });
});

describe('runEmbed', () => {
  it('rejects vectors of different dimensions within one request', async () => {
    const { adapter } = scripted({ vectors: [[1, 2], [1, 2, 3]] });
    const r = await runEmbed(adapter, request(), deps());
    expect(r.outcome).toEqual({ ok: false, category: 'rejected' });
  });

  it('rejects a different number of vectors than texts', async () => {
    const { adapter } = scripted({ vectors: [[1, 2]] });
    expect((await runEmbed(adapter, request(), deps())).outcome).toEqual({ ok: false, category: 'rejected' });
  });

  it('rejects vectors of different dimensions across batches', async () => {
    const { adapter } = scripted({ vectors: [[1, 2]] }, { vectors: [[1, 2, 3]] });
    expect((await runEmbed(adapter, request({ batchSize: 1 }), deps())).outcome).toEqual({ ok: false, category: 'rejected' });
  });

  it('stops between batches when cancelled, and sends nothing more', async () => {
    const controller = new AbortController();
    const { adapter, calls } = scripted(
      () => {
        controller.abort();
        return Promise.resolve({ vectors: [[1]] });
      },
      { vectors: [[2]] },
    );
    const r = await runEmbed(adapter, request({ batchSize: 1, signal: controller.signal }), deps());
    expect(r.outcome).toEqual({ ok: false, category: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('does not send anything for a request that is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, calls } = scripted({ vectors: [[1], [2]] });
    const r = await runEmbed(adapter, request({ signal: controller.signal }), deps());
    expect(r.outcome).toEqual({ ok: false, category: 'cancelled' });
    expect(calls).toHaveLength(0);
    expect(r.attempts).toBe(0);
  });

  it('retries a transient failure at most twice for the whole request, waiting 1 s then 2 s', async () => {
    const waits: number[] = [];
    const { adapter, calls } = scripted(new AdapterError('rate_limited'), new AdapterError('provider_unavailable'), { vectors: [[1], [2]] });
    const r = await runEmbed(adapter, request(), deps(waits));
    expect(r.outcome.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect(r.attempts).toBe(3);

    const again = scripted(new AdapterError('rate_limited'), new AdapterError('rate_limited'), new AdapterError('rate_limited'), { vectors: [[1], [2]] });
    expect((await runEmbed(again.adapter, request(), deps())).outcome).toEqual({ ok: false, category: 'rate_limited' });
    expect(again.calls).toHaveLength(3);
  });

  it('a call that never settles ends at the time limit and is retried', async () => {
    const { adapter, calls } = scripted(() => new Promise<Embedded>(() => undefined), { vectors: [[1], [2]] });
    const r = await runEmbed(adapter, request({ timeoutMs: 80 }), deps());
    expect(r.outcome.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('does not retry a failure that retrying cannot fix', async () => {
    const { adapter, calls } = scripted(new AdapterError('not_authorized'), { vectors: [[1], [2]] });
    expect((await runEmbed(adapter, request(), deps())).outcome).toEqual({ ok: false, category: 'not_authorized' });
    expect(calls).toHaveLength(1);
  });
});

describe('usage and cost of an embedding request', () => {
  it('writes one record and one log line, with no temperature, priced from EMBEDDING_PRICE_INPUT', async () => {
    const stub = await startStub();
    stub.enqueue(openaiEmbeddings([[1, 2]], 1_000_000));
    const lines: string[] = [];
    const llm = createLlmWithEndpoints(
      config({ embedding: operation('openai-compatible', { model: 'x', baseUrl: `${stub.url}/v1`, operatorPrice: { input: 0.15, output: null } }) }),
      { log: (l) => lines.push(l), endpoints: {} },
    );
    const result = await llm.embed({ texts: ['hello'] });
    await stub.close();
    expect(result.usage).toMatchObject({ operation: 'embed', temperatureApplied: null, costUsd: 0.15, priceSource: 'operator', outputTokens: 0 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ operation: 'embed', temperature_applied: null, cost_usd: 0.15 });
  });
});
