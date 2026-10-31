import { describe, expect, it } from 'vitest';
import { FAILURE_MESSAGES, LlmConfigError, LlmSchemaError } from '../src/errors.js';

const CATEGORIES = [
  'not_configured',
  'not_authorized',
  'not_available',
  'rate_limited',
  'provider_unavailable',
  'input_too_large',
  'output_limit_reached',
  'refused',
  'rejected',
  'invalid_output',
  'cancelled',
];

describe('FAILURE_MESSAGES', () => {
  it('has exactly the categories of FR-020, in the order of the library contract', () => {
    expect(Object.keys(FAILURE_MESSAGES)).toEqual(CATEGORIES);
  });

  it.each(CATEGORIES)('%s has fixed text with no placeholder', (category) => {
    const message = FAILURE_MESSAGES[category as keyof typeof FAILURE_MESSAGES];
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('{{');
    expect(message).not.toContain('${');
  });
});

describe('error classes', () => {
  it('are distinct Error subclasses with a fixed name', () => {
    const config = new LlmConfigError('LLM_MODEL must be set');
    const schema = new LlmSchemaError('not strict');
    expect(config).toBeInstanceOf(Error);
    expect(schema).toBeInstanceOf(Error);
    expect(config).not.toBeInstanceOf(LlmSchemaError);
    expect(schema).not.toBeInstanceOf(LlmConfigError);
    expect(config.name).toBe('LlmConfigError');
    expect(schema.name).toBe('LlmSchemaError');
    expect(config.message).toBe('LLM_MODEL must be set');
  });
});
