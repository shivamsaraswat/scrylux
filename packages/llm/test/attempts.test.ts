import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runGenerate, type LoopRequest } from '../src/attempts.js';
import { resetCapabilityOverrides } from '../src/capabilities.js';
import { AdapterError } from '../src/errors.js';
import type { Adapter, GenerateInput, GenerateOutcome } from '../src/adapters/types.js';

const schema = z.strictObject({ name: z.string(), type: z.enum(['a', 'b']) });
const GOOD = JSON.stringify({ name: 'n', type: 'a' });
const answer = (text: string, inputTokens?: number, outputTokens?: number): GenerateOutcome => ({
  kind: 'answer',
  text,
  ...(inputTokens === undefined ? {} : { inputTokens }),
  ...(outputTokens === undefined ? {} : { outputTokens }),
});

type Step = GenerateOutcome | AdapterError | ((input: GenerateInput) => Promise<GenerateOutcome>);

function scripted(...steps: Step[]) {
  const calls: GenerateInput[] = [];
  const adapter: Adapter = {
    async generateOnce(input) {
      calls.push(input);
      const step = steps.shift();
      if (step === undefined) throw new Error('script is empty');
      if (step instanceof AdapterError) throw step;
      return typeof step === 'function' ? step(input) : step;
    },
    embedBatch: () => Promise.reject(new Error('not used')),
  };
  return { adapter, calls };
}

function deps(random = 0) {
  const waits: number[] = [];
  return {
    waits,
    deps: {
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
      random: () => random,
    },
  };
}

function request(over: Partial<LoopRequest<z.infer<typeof schema>>> = {}): LoopRequest<z.infer<typeof schema>> {
  return {
    provider: 'anthropic',
    model: 'claude-test',
    schema,
    schemaName: 'test',
    system: 'SYS',
    user: 'USER',
    jsonSchema: { type: 'object' },
    instructionSchema: { type: 'object', title: 'MARKER-SCHEMA' },
    maxOutputTokens: 16000,
    attemptLimit: 3,
    timeoutMs: 60_000,
    ...over,
  };
}

afterEach(() => resetCapabilityOverrides());

describe('schema attempts (FR-013, FR-014)', () => {
  it('1. returns a valid first answer', async () => {
    const { adapter, calls } = scripted(answer(GOOD, 10, 5));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: true, value: { name: 'n', type: 'a' } });
    expect(r.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(r.calls.map((c) => [c.inputTokens, c.outputTokens])).toEqual([[10, 5]]);
  });

  it('2. asks again with a note that lists the problems and never quotes the invalid answer', async () => {
    const bad = JSON.stringify({ name: 123, type: 'WRONG-VALUE-xyz' });
    const { adapter, calls } = scripted(answer(bad, 10, 5), answer(GOOD, 12, 6));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(calls[0]?.retryNote).toBeUndefined();
    const note = calls[1]?.retryNote ?? '';
    expect(note).toContain('did not match the required format');
    expect(note).toContain('name:');
    expect(note).toContain('type:');
    expect(note).toMatch(/"a"/);
    expect(note).toMatch(/"b"/);
    expect(note).not.toContain('WRONG-VALUE-xyz');
    expect(note).not.toContain('{{');
    expect(r.calls.map((c) => c.inputTokens)).toEqual([10, 12]);
  });

  it('2b. says so when the answer is not JSON at all', async () => {
    const { adapter, calls } = scripted(answer('Sure! Here it is.'), answer(GOOD));
    await runGenerate(adapter, request(), deps().deps);
    expect(calls[1]?.retryNote).toContain('not valid JSON');
    expect(calls[1]?.retryNote).not.toContain('Sure!');
  });

  it('3. fails as invalid_output after the attempt limit, with no value', async () => {
    const { adapter, calls } = scripted(answer('{}'), answer('{}'), answer('{}'));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'invalid_output' });
    expect(r.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('4. does not retry with an attempt limit of 1', async () => {
    const { adapter, calls } = scripted(answer('{}'), answer(GOOD));
    const r = await runGenerate(adapter, request({ attemptLimit: 1 }), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'invalid_output' });
    expect(calls).toHaveLength(1);
  });

  it('5. treats valid JSON with an extra field as invalid', async () => {
    const extra = JSON.stringify({ name: 'n', type: 'a', extra: 1 });
    const { adapter } = scripted(answer(extra), answer(extra), answer(extra));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'invalid_output' });
  });
});

describe('failures that are not retried (FR-021)', () => {
  it('6. a cut-off answer fails as output_limit_reached after one call', async () => {
    const { adapter, calls } = scripted({ kind: 'cut_off', inputTokens: 5, outputTokens: 16000 }, answer(GOOD));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'output_limit_reached' });
    expect(calls).toHaveLength(1);
    expect(r.calls[0]?.outputTokens).toBe(16000);
  });

  it('7. a refusal fails as refused after one call', async () => {
    const { adapter, calls } = scripted({ kind: 'refused' }, answer(GOOD));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'refused' });
    expect(calls).toHaveLength(1);
  });

  it.each(['not_authorized', 'not_available', 'input_too_large', 'rejected'] as const)('8. %s fails after one call', async (category) => {
    const { adapter, calls } = scripted(new AdapterError(category), answer(GOOD));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category });
    expect(calls).toHaveLength(1);
    expect(r.attempts).toBe(1);
  });
});

describe('transient retries (FR-022, SC-008)', () => {
  it('9. waits 1 s then 2 s, plus up to 25%, and succeeds on the third call', async () => {
    const { adapter, calls } = scripted(new AdapterError('rate_limited'), new AdapterError('rate_limited'), answer(GOOD));
    const w = deps(0);
    const r = await runGenerate(adapter, request(), w.deps);
    expect(r.outcome.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(r.attempts).toBe(3);
    expect(w.waits).toEqual([1000, 2000]);

    const { adapter: again } = scripted(new AdapterError('rate_limited'), new AdapterError('rate_limited'), answer(GOOD));
    const j = deps(1);
    await runGenerate(again, request(), j.deps);
    expect(j.waits).toEqual([1250, 2500]);
  });

  it('10. a provider that is always unavailable fails after exactly 3 calls', async () => {
    const { adapter, calls } = scripted(
      new AdapterError('provider_unavailable'),
      new AdapterError('provider_unavailable'),
      new AdapterError('provider_unavailable'),
      answer(GOOD),
    );
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'provider_unavailable' });
    expect(calls).toHaveLength(3);
    expect(r.attempts).toBe(3);
  });

  it('11. counts transient retries across schema attempts: at most 2 in total', async () => {
    const { adapter, calls } = scripted(
      new AdapterError('rate_limited'),
      answer('{}'),
      new AdapterError('provider_unavailable'),
      new AdapterError('rate_limited'),
      answer(GOOD),
    );
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'rate_limited' });
    expect(calls).toHaveLength(4);
  });

  it('12. honours a retry-after that is longer than the usual wait', async () => {
    const { adapter } = scripted(new AdapterError('rate_limited', { retryAfterMs: 5000 }), answer(GOOD));
    const w = deps(0);
    await runGenerate(adapter, request(), w.deps);
    expect(w.waits).toEqual([5000]);
  });

  it('13. fails as rate_limited at once when the provider asks for more than 60 s', async () => {
    const { adapter, calls } = scripted(new AdapterError('rate_limited', { retryAfterMs: 61_000 }), answer(GOOD));
    const w = deps();
    const r = await runGenerate(adapter, request(), w.deps);
    expect(r.outcome).toEqual({ ok: false, category: 'rate_limited' });
    expect(calls).toHaveLength(1);
    expect(w.waits).toEqual([]);
  });
});

describe('free resends (research #4, #6)', () => {
  it('14. resends once without a temperature, remembers, and counts no attempt', async () => {
    const { adapter, calls } = scripted(new AdapterError('rejected', { rejectedParam: 'temperature' }), answer(GOOD));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome.ok).toBe(true);
    expect(calls.map((c) => c.temperature)).toEqual([0, undefined]);
    expect(r.attempts).toBe(1);
    expect(r.calls).toHaveLength(2);
    expect(r.temperatureApplied).toBe(false);

    const next = scripted(answer(GOOD));
    await runGenerate(next.adapter, request(), deps().deps);
    expect(next.calls[0]?.temperature).toBeUndefined();
  });

  it('14b. fails as rejected if a model still refuses the temperature that was already left out', async () => {
    const { adapter } = scripted(
      new AdapterError('rejected', { rejectedParam: 'temperature' }),
      new AdapterError('rejected', { rejectedParam: 'temperature' }),
    );
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'rejected' });
  });

  it('15. steps the format down for anthropic (native -> instructions) and adds the JSON instructions', async () => {
    const { adapter, calls } = scripted(new AdapterError('rejected', { rejectedParam: 'format' }), answer(GOOD));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(r.outcome.ok).toBe(true);
    expect(calls.map((c) => c.mode)).toEqual(['native', 'instructions']);
    expect(calls[0]?.system).toBe('SYS');
    expect(calls[1]?.system).toContain('SYS');
    expect(calls[1]?.system).toContain('MARKER-SCHEMA');
    expect(r.attempts).toBe(1);
  });

  it('15b. steps native -> json_object -> instructions for openai-compatible, then gives up', async () => {
    const refuse = () => new AdapterError('rejected', { rejectedParam: 'format' });
    const { adapter, calls } = scripted(refuse(), refuse(), refuse());
    const r = await runGenerate(adapter, request({ provider: 'openai-compatible', model: 'm' }), deps().deps);
    expect(calls.map((c) => c.mode)).toEqual(['native', 'json_object', 'instructions']);
    expect(r.outcome).toEqual({ ok: false, category: 'rejected' });
  });

  it('16. resends once with max_completion_tokens for an openai-compatible model', async () => {
    const { adapter, calls } = scripted(new AdapterError('rejected', { rejectedParam: 'max_tokens' }), answer(GOOD));
    const r = await runGenerate(adapter, request({ provider: 'openai-compatible', model: 'my-deployment' }), deps().deps);
    expect(r.outcome.ok).toBe(true);
    expect(calls.map((c) => c.maxTokensParam)).toEqual(['max_tokens', 'max_completion_tokens']);
    expect(r.attempts).toBe(1);

    const next = scripted(answer(GOOD));
    await runGenerate(next.adapter, request({ provider: 'openai-compatible', model: 'my-deployment' }), deps().deps);
    expect(next.calls[0]?.maxTokensParam).toBe('max_completion_tokens');
  });
});

describe('cancellation (FR-023, SC-007)', () => {
  it('17. a cancel during an adapter call reaches the adapter and ends the request within 1 s', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const { adapter } = scripted((input) => {
      seen = input.signal;
      return new Promise<GenerateOutcome>((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const r = await runGenerate(adapter, request({ signal: controller.signal }), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen?.aborted).toBe(true);
  });

  it('17b. ends even when the adapter ignores the signal', async () => {
    const controller = new AbortController();
    const { adapter } = scripted(() => new Promise<GenerateOutcome>(() => undefined));
    setTimeout(() => controller.abort(), 30);
    const r = await runGenerate(adapter, request({ signal: controller.signal }), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'cancelled' });
  });

  it('18. a cancel during a wait makes no further call', async () => {
    const controller = new AbortController();
    const { adapter, calls } = scripted(new AdapterError('rate_limited'), answer(GOOD));
    const r = await runGenerate(adapter, request({ signal: controller.signal }), {
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
      random: () => 0,
    });
    expect(r.outcome).toEqual({ ok: false, category: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('18b. an already-cancelled request makes no call', async () => {
    const controller = new AbortController();
    controller.abort();
    const { adapter, calls } = scripted(answer(GOOD));
    const r = await runGenerate(adapter, request({ signal: controller.signal }), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'cancelled' });
    expect(calls).toHaveLength(0);
    expect(r.attempts).toBe(0);
  });
});

describe('the time limit (FR-010), enforced in the loop', () => {
  it('19. a call that never settles counts as provider_unavailable and is retried', async () => {
    const { adapter, calls } = scripted(() => new Promise<GenerateOutcome>(() => undefined), answer(GOOD));
    const started = Date.now();
    const r = await runGenerate(adapter, request({ timeoutMs: 100 }), deps().deps);
    expect(r.outcome.ok).toBe(true);
    expect(r.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('19b. gives the adapter a signal that fires at the limit', async () => {
    let fired = false;
    const { adapter } = scripted(
      (input) =>
        new Promise<GenerateOutcome>(() => {
          input.signal.addEventListener('abort', () => (fired = true));
        }),
      answer(GOOD),
    );
    await runGenerate(adapter, request({ timeoutMs: 80 }), deps().deps);
    expect(fired).toBe(true);
  });

  it('20. the caller cancelling first is cancelled, not provider_unavailable', async () => {
    const controller = new AbortController();
    const { adapter } = scripted(() => new Promise<GenerateOutcome>(() => undefined));
    setTimeout(() => controller.abort(), 20);
    const r = await runGenerate(adapter, request({ signal: controller.signal, timeoutMs: 5000 }), deps().deps);
    expect(r.outcome).toEqual({ ok: false, category: 'cancelled' });
  });
});

describe('what the adapter is given', () => {
  it('21. temperature is 0 when the model accepts one, and temperatureApplied says so', async () => {
    const { adapter, calls } = scripted(answer(GOOD));
    const r = await runGenerate(adapter, request(), deps().deps);
    expect(calls[0]?.temperature).toBe(0);
    expect(r.temperatureApplied).toBe(true);
  });

  it('21b. no temperature for a model that omits it, and temperatureApplied is false', async () => {
    const { adapter, calls } = scripted(answer(GOOD));
    const r = await runGenerate(adapter, request({ model: 'claude-opus-5-5' }), deps().deps);
    expect(calls[0]?.temperature).toBeUndefined();
    expect(r.temperatureApplied).toBe(false);
  });

  it('21c. passes the limits, the schema name and the time limit through', async () => {
    const { adapter, calls } = scripted(answer(GOOD));
    await runGenerate(adapter, request({ maxOutputTokens: 123, schemaName: 'thing', timeoutMs: 4567 }), deps().deps);
    expect(calls[0]).toMatchObject({ maxOutputTokens: 123, schemaName: 'thing', timeoutMs: 4567, mode: 'native', user: 'USER' });
  });

  it('21d. records the size of what it sent and received, for estimates', async () => {
    const { adapter } = scripted(answer(GOOD));
    const r = await runGenerate(adapter, request({ system: 'S'.repeat(40), user: 'U'.repeat(60) }), deps().deps);
    expect(r.calls[0]?.inputChars).toBe(100);
    expect(r.calls[0]?.outputChars).toBe(GOOD.length);
  });
});
