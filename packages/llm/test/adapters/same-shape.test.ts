import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlmWithEndpoints, resetCapabilityOverrides } from '../../testing/index.js';
import type { Llm, ProviderName } from '../../src/index.js';
import { anthropicMessage } from '../../testing/stubs/anthropic.js';
import { converseAnswer } from '../../testing/stubs/bedrock.js';
import { geminiAnswer } from '../../testing/stubs/gemini.js';
import { openaiCompletion } from '../../testing/stubs/openai.js';
import { startStub, type Scripted, type Stub } from '../../testing/stubs/server.js';
import { config, operation } from '../helpers.js';

// Guard test (T031): one request through each adapter gives the same result and the same usage shape, whichever
// provider answered (US1 scenario 4, SC-002). The behaviour itself is tested adapter by adapter.

const schema = z.strictObject({ name: z.string(), type: z.enum(['a', 'b']) });
const GOOD = '{"name":"n","type":"a"}';
const BAD = '{"name":"n"}';

interface Case {
  provider: ProviderName;
  http2: boolean;
  answer: (text: string) => Scripted;
}
const cases: Case[] = [
  { provider: 'anthropic', http2: false, answer: (text) => anthropicMessage({ text }) },
  { provider: 'openai-compatible', http2: false, answer: (text) => openaiCompletion({ content: text }) },
  { provider: 'bedrock', http2: true, answer: (text) => converseAnswer({ text }) },
  { provider: 'gemini', http2: false, answer: (text) => geminiAnswer({ text }) },
];

describe.each(cases)('$provider', ({ provider, http2, answer }) => {
  let stub: Stub;
  let llm: Llm;

  beforeEach(async () => {
    resetCapabilityOverrides();
    stub = await startStub({ http2 });
    llm = createLlmWithEndpoints(
      config({
        generation: operation(provider, {
          model: 'same-shape-model',
          ...(provider === 'openai-compatible' ? { baseUrl: `${stub.url}/v1` } : {}),
        }),
      }),
      {
        log: () => undefined,
        endpoints: {
          anthropic: { baseURL: stub.url },
          gemini: { baseUrl: stub.url },
          bedrock: { endpoint: stub.url, credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' } },
        },
      },
    );
  });
  afterEach(() => stub.close());

  const request = { schema, schemaName: 'thing', instructions: 'Describe the thing.' };

  it('returns the validated value and a usage record', async () => {
    stub.enqueue(answer(GOOD));
    const result = await llm.generate(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ name: 'n', type: 'a' });
    expect(result.usage).toMatchObject({ operation: 'generate', provider, model: 'same-shape-model', outcome: 'ok', attempts: 1 });
  });

  it('asks again after an answer with a missing field, and records two attempts', async () => {
    stub.enqueue(answer(BAD), answer(GOOD));
    const result = await llm.generate(request);
    expect(result.ok).toBe(true);
    expect(result.usage.attempts).toBe(2);
    expect(stub.requests).toHaveLength(2);
  });

  it('fails as invalid_output, with no value, when no answer is ever valid', async () => {
    stub.enqueue(answer(BAD), answer(BAD), answer(BAD), answer(GOOD));
    const result = await llm.generate(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.category).toBe('invalid_output');
    expect(result.usage.attempts).toBe(3);
    expect(stub.requests).toHaveLength(3);
  });

  it('puts untrusted content only in the marked section of the user turn', async () => {
    stub.enqueue(answer(GOOD));
    await llm.generate({ ...request, content: 'CONTENT-MARKER-TEXT' });
    const sent = JSON.stringify(stub.requests[0]?.body);
    expect(sent).toContain('CONTENT-MARKER-TEXT');
    expect(sent.match(/CONTENT-MARKER-TEXT/g)).toHaveLength(1);
    expect(sent).toContain('<<<SCRYLUX-CONTENT ');
  });
});

describe('the four adapters agree', () => {
  it('gives deep-equal values and usage records that differ only in provider, model and tokens', async () => {
    const outcomes = [];
    for (const { provider, http2, answer } of cases) {
      resetCapabilityOverrides();
      const stub = await startStub({ http2 });
      stub.enqueue(answer(GOOD));
      const llm = createLlmWithEndpoints(
        config({ generation: operation(provider, { model: `model-for-${provider}`, ...(provider === 'openai-compatible' ? { baseUrl: `${stub.url}/v1` } : {}) }) }),
        {
          log: () => undefined,
          endpoints: {
            anthropic: { baseURL: stub.url },
            gemini: { baseUrl: stub.url },
            bedrock: { endpoint: stub.url, credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' } },
          },
        },
      );
      const result = await llm.generate({ schema, schemaName: 'thing', instructions: 'Describe the thing.' });
      await stub.close();
      expect(result.ok).toBe(true);
      outcomes.push({
        value: result.ok ? result.value : undefined,
        usage: { ...result.usage, provider: 'x', model: 'x', inputTokens: 0, outputTokens: 0, durationMs: 0, temperatureApplied: null },
      });
    }
    for (const outcome of outcomes.slice(1)) expect(outcome).toEqual(outcomes[0]);
  });
});
