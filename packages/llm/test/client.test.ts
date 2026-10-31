import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlm, FAILURE_MESSAGES, LlmSchemaError } from '../src/index.js';
import { resetCapabilityOverrides } from '../testing/index.js';
import { config, operation } from './helpers.js';

afterEach(() => resetCapabilityOverrides());

const schema = z.strictObject({ a: z.string() });
const base = { schema, schemaName: 'thing', instructions: 'Do it.' };

describe('generate without a configured provider', () => {
  it('resolves at once to not_configured with a zero-attempt usage record', async () => {
    const llm = createLlm(config());
    const result = await llm.generate(base);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ category: 'not_configured', message: FAILURE_MESSAGES.not_configured });
    expect(result.usage).toMatchObject({ operation: 'generate', provider: null, model: null, outcome: 'not_configured', attempts: 0, inputTokens: 0, outputTokens: 0, costUsd: null, priceSource: 'none' });
  });

  it('loads no SDK', async () => {
    // createLlm does no I/O and the not-configured path builds no adapter: nothing is imported, so nothing can fail.
    await expect(createLlm(config()).generate(base)).resolves.toMatchObject({ ok: false });
  });
});

describe('argument checks throw before any request is sent', () => {
  const llm = createLlm(config({ generation: operation('anthropic') }));

  it('refuses a schema that is not strict', async () => {
    await expect(llm.generate({ ...base, schema: z.object({ a: z.string() }) })).rejects.toThrow(LlmSchemaError);
  });

  it.each(['', 'has space', 'x'.repeat(65), 'bad!'])('refuses schemaName %j', async (schemaName) => {
    await expect(llm.generate({ ...base, schemaName })).rejects.toThrow(LlmSchemaError);
  });

  it('refuses empty instructions', async () => {
    await expect(llm.generate({ ...base, instructions: '  ' })).rejects.toThrow(RangeError);
  });

  it.each([0, -1, 1.5, 32_001])('refuses maxOutputTokens %j', async (maxOutputTokens) => {
    await expect(llm.generate({ ...base, maxOutputTokens })).rejects.toThrow(RangeError);
  });

  it('refuses an attempt limit outside 1 to 3', async () => {
    await expect(llm.generate({ ...base, attemptLimit: 4 as 3 })).rejects.toThrow(RangeError);
    await expect(llm.generate({ ...base, attemptLimit: 0 as 1 })).rejects.toThrow(RangeError);
  });
});
