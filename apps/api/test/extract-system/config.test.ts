import { describe, expect, it } from 'vitest';
import {
  ExtractionConfigError,
  checkExtractionConfig,
  currentExtractionConfig,
  parseExtractionConfig,
} from '../../src/extract-system/config.js';

// The two settings of extraction (Phase 3 Milestone 4, contracts/configuration.md). The app and the worker parse both when they
// start, so a bad value stops either one with the variable's name and never its value (FR-010).

type Env = Record<string, string | undefined>;

function problem(env: Env): string {
  try {
    parseExtractionConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ExtractionConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the settings to be refused');
}

const ALL = ['EXTRACTION_CONTEXT_CHARS', 'EXTRACTION_MAX_OUTPUT_TOKENS'];

describe('the defaults', () => {
  it('are 36,000 characters of context and 12,000 output tokens', () => {
    expect(parseExtractionConfig({})).toEqual({ contextChars: 36_000, maxOutputTokens: 12_000 });
  });

  it('are used for a variable that is set to nothing', () => {
    expect(parseExtractionConfig({ EXTRACTION_CONTEXT_CHARS: '', EXTRACTION_MAX_OUTPUT_TOKENS: '' })).toEqual({
      contextChars: 36_000,
      maxOutputTokens: 12_000,
    });
  });
});

describe('the accepted values, at both ends of each range', () => {
  it.each([
    [{ EXTRACTION_CONTEXT_CHARS: '2000' }, { contextChars: 2000 }],
    [{ EXTRACTION_CONTEXT_CHARS: '2000000' }, { contextChars: 2_000_000 }],
    [{ EXTRACTION_CONTEXT_CHARS: '36000' }, { contextChars: 36_000 }],
    [{ EXTRACTION_MAX_OUTPUT_TOKENS: '1000' }, { maxOutputTokens: 1000 }],
    [{ EXTRACTION_MAX_OUTPUT_TOKENS: '32000' }, { maxOutputTokens: 32_000 }],
  ])('%j gives %j', (env, expected) => {
    expect(parseExtractionConfig(env)).toMatchObject(expected);
  });
});

describe('the refusals', () => {
  it.each([
    ['EXTRACTION_CONTEXT_CHARS', ['0', '1999', '2000001', '-1', '1.5', '36k', 'many', ' 36000', '1e4', '36,000']],
    ['EXTRACTION_MAX_OUTPUT_TOKENS', ['0', '999', '32001', '-1', '12000.5', '12k', 'lots', '1e4']],
  ])('%s refuses %j', (name, values) => {
    for (const value of values) {
      expect(problem({ [name]: value }), `${name}=${value}`).toContain(name);
    }
  });

  it('never repeats the value, however bad', () => {
    for (const name of ALL) {
      const message = problem({ [name]: 'SECRET-VALUE-9' });
      expect(message).toContain(name);
      expect(message).not.toContain('SECRET-VALUE-9');
      expect(message).not.toContain('SECRET');
    }
  });

  it('names the first problem in a fixed order, whatever order the environment lists its variables in', () => {
    const first = problem({ EXTRACTION_MAX_OUTPUT_TOKENS: '0', EXTRACTION_CONTEXT_CHARS: '0' });
    const second = problem({ EXTRACTION_CONTEXT_CHARS: '0', EXTRACTION_MAX_OUTPUT_TOKENS: '0' });
    expect(first).toBe(second);
    expect(first).toContain('EXTRACTION_CONTEXT_CHARS');
  });
});

describe('checkExtractionConfig', () => {
  it('returns the settings when they are right', () => {
    const result = checkExtractionConfig({ EXTRACTION_CONTEXT_CHARS: '8000' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.contextChars).toBe(8000);
  });

  it('returns a line that names the setting and never its value, for the start-up message', () => {
    const result = checkExtractionConfig({ EXTRACTION_MAX_OUTPUT_TOKENS: 'BAD-VALUE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.line).toMatch(/^Startup failed: EXTRACTION_MAX_OUTPUT_TOKENS /);
      expect(result.line).not.toContain('BAD-VALUE');
    }
  });
});

describe('currentExtractionConfig', () => {
  it('reads the process environment each time', () => {
    const before = process.env.EXTRACTION_CONTEXT_CHARS;
    try {
      process.env.EXTRACTION_CONTEXT_CHARS = '9000';
      expect(currentExtractionConfig().contextChars).toBe(9000);
      process.env.EXTRACTION_CONTEXT_CHARS = '12000';
      expect(currentExtractionConfig().contextChars).toBe(12_000);
    } finally {
      if (before === undefined) delete process.env.EXTRACTION_CONTEXT_CHARS;
      else process.env.EXTRACTION_CONTEXT_CHARS = before;
    }
  });

  it('falls back to the defaults for a bad value, because importing a module must never throw', () => {
    const before = process.env.EXTRACTION_CONTEXT_CHARS;
    try {
      process.env.EXTRACTION_CONTEXT_CHARS = 'nonsense';
      expect(currentExtractionConfig()).toEqual({ contextChars: 36_000, maxOutputTokens: 12_000 });
    } finally {
      if (before === undefined) delete process.env.EXTRACTION_CONTEXT_CHARS;
      else process.env.EXTRACTION_CONTEXT_CHARS = before;
    }
  });
});
