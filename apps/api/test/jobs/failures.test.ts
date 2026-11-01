import { readFileSync } from 'node:fs';
import { JOB_FAILURE_CATEGORIES } from '@scrylux/core';
import { FAILURE_MESSAGES, type FailureCategory } from '@scrylux/llm';
import { describe, expect, it } from 'vitest';
import { describeFailure, describeSourceCancelled, loadFailures, parseFailuresFile, providerHint } from '../../src/jobs/failures.js';

// apps/api/data/failures.yaml: the message and hint of every failure a job can show, which the operator's check command
// shares (Phase 3 Milestone 2, FR-064, contracts/data-files.md). Milestone 3 adds the categories of ingestion, a message for
// each detail of a failure that names a bound, a hint per job kind, and the text a cancelled source shows (FR-013).

const PROVIDER_CATEGORIES = Object.keys(FAILURE_MESSAGES) as FailureCategory[];
const JOB_KEYS = [
  'cap_below_one_request',
  'cap_reached',
  'damaged',
  'document_space_full',
  'encrypted',
  'job_error',
  'no_text_found',
  'storage_unavailable',
  'timed_out',
  'too_large',
  'too_large_chars',
  'too_large_pages',
  'too_large_unpacked',
  'unreadable',
  'unreadable_memory',
  'unreadable_time',
  'unsupported_type',
  'worker_lost',
];
const KIND_NAMES = ['ingest_source', 'refresh_embeddings'];

const FILE_TEXT = readFileSync(new URL('../../data/failures.yaml', import.meta.url), 'utf8');

/** A valid file in memory, to change one thing at a time. */
function valid(): {
  provider: Record<string, string>;
  job: Record<string, { message: string; hint: string }>;
  kinds: Record<string, Record<string, string>>;
  source: Record<string, { message: string; hint: string }>;
} {
  return {
    provider: Object.fromEntries(PROVIDER_CATEGORIES.map((c) => [c, `Check {prefix}_MODEL for ${c}.`])),
    job: Object.fromEntries(JOB_KEYS.map((k) => [k, { message: `The ${k} message.`, hint: `The ${k} hint.` }])),
    kinds: Object.fromEntries(KIND_NAMES.map((k) => [k, { input_too_large: `The ${k} hint for a chunk that is too large.` }])),
    source: { cancelled: { message: 'The source message.', hint: 'The source hint.' } },
  };
}

const entryYaml = (indent: string, entry: { message: string; hint: string }): string[] => [
  `${indent}message: ${JSON.stringify(entry.message)}`,
  `${indent}hint: ${JSON.stringify(entry.hint)}`,
];

const toYaml = (file: ReturnType<typeof valid>): string =>
  [
    'provider:',
    ...Object.entries(file.provider).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    'job:',
    ...Object.entries(file.job).flatMap(([k, v]) => [`  ${k}:`, ...entryYaml('    ', v)]),
    'kinds:',
    ...Object.entries(file.kinds).flatMap(([k, v]) => [`  ${k}:`, ...Object.entries(v).map(([c, hint]) => `    ${c}: ${JSON.stringify(hint)}`)]),
    'source:',
    ...Object.entries(file.source).flatMap(([k, v]) => [`  ${k}:`, ...entryYaml('    ', v)]),
  ].join('\n');

describe('the shipped file', () => {
  it('has a hint for each of Milestone 1’s eleven categories', () => {
    expect(PROVIDER_CATEGORIES).toHaveLength(11);
    const { provider } = loadFailures();
    expect(Object.keys(provider).sort()).toEqual([...PROVIDER_CATEGORIES].sort());
    for (const text of Object.values(provider)) expect(text.length).toBeGreaterThan(10);
  });

  it('has a message and a hint for each job category and each detail that names a bound, and no other key', () => {
    const { job } = loadFailures();
    expect(Object.keys(job).sort()).toEqual(JOB_KEYS);
    for (const entry of Object.values(job)) {
      expect(entry.message.length).toBeGreaterThan(10);
      expect(entry.hint.length).toBeGreaterThan(10);
    }
  });

  it('uses {prefix} as its only placeholder, and names no address and no value', () => {
    expect(FILE_TEXT.replaceAll('{prefix}', '')).not.toMatch(/[{}]/);
    expect(FILE_TEXT).not.toMatch(/https?:\/\//);
    expect(FILE_TEXT).not.toMatch(/\$\{|\{\{/);
  });

  it('keeps the hints that Milestone 1’s check command printed, word for word', () => {
    expect(providerHint('not_authorized', 'LLM')).toBe(
      'Check LLM_API_KEY, and that the key may use this model. For Bedrock, check the role’s permissions.',
    );
    expect(providerHint('not_available', 'EMBEDDING')).toBe(
      'Check EMBEDDING_MODEL. For Ollama, run `ollama pull <model>` first. For Bedrock, check that the model is enabled in EMBEDDING_REGION.',
    );
    expect(providerHint('not_configured', 'EMBEDDING')).toBe('Check EMBEDDING_PROVIDER.');
  });

  it('gives a cancelled request a hint of its own, which names no setting: nothing is wrong with the provider (US3)', () => {
    expect(providerHint('cancelled', 'LLM')).toBe('The request was stopped before it finished. Nothing is wrong with the provider.');
    expect(providerHint('cancelled', 'EMBEDDING')).not.toMatch(/PROVIDER|MODEL|API_KEY/);
  });
});

describe('parseFailuresFile', () => {
  it('accepts a valid file', () => {
    expect(parseFailuresFile(toYaml(valid())).job.timed_out).toEqual({ message: 'The timed_out message.', hint: 'The timed_out hint.' });
  });

  it('refuses an unknown key at the top, among the categories, and inside a job entry', () => {
    expect(() => parseFailuresFile(`${toYaml(valid())}\nextra: 1`)).toThrow();
    expect(() => parseFailuresFile(`${toYaml(valid())}\n  surprise: "x"`)).toThrow();
    const unknownJob = valid();
    unknownJob.job.mystery = { message: 'm', hint: 'h' };
    expect(() => parseFailuresFile(toYaml(unknownJob))).toThrow();
    const extraField = toYaml(valid()).replace('    hint: "The timed_out hint."', '    hint: "The timed_out hint."\n    note: "no"');
    expect(() => parseFailuresFile(extraField)).toThrow();
  });

  it('refuses a missing category, a missing job entry and an empty text', () => {
    const missing = valid();
    delete missing.provider.refused;
    expect(() => parseFailuresFile(toYaml(missing))).toThrow();
    const missingJob = valid();
    delete missingJob.job.job_error;
    expect(() => parseFailuresFile(toYaml(missingJob))).toThrow();
    const empty = valid();
    empty.provider.refused = '';
    expect(() => parseFailuresFile(toYaml(empty))).toThrow();
  });

  it('refuses a placeholder other than {prefix}', () => {
    const odd = valid();
    odd.provider.refused = 'Check {model} please.';
    expect(() => parseFailuresFile(toYaml(odd))).toThrow(/placeholder/);
    const doubled = valid();
    doubled.job.timed_out = { message: 'Ran out of {{time}}.', hint: 'h' };
    expect(() => parseFailuresFile(toYaml(doubled))).toThrow(/placeholder/);
  });

  it('refuses an address, which a hint must not carry', () => {
    const link = valid();
    link.job.timed_out = { message: 'm', hint: 'See https://example.com' };
    expect(() => parseFailuresFile(toYaml(link))).toThrow(/address/);
  });

  it('refuses duplicate keys, YAML aliases and more than one document, like Milestone 1’s data files', () => {
    expect(() => parseFailuresFile(`${toYaml(valid())}\nprovider: {}`)).toThrow();
    expect(() => parseFailuresFile(toYaml(valid()).replace('  refused:', '  refused: &a'))).toThrow();
    expect(() => parseFailuresFile(`${toYaml(valid())}\n---\nprovider: {}`)).toThrow();
  });
});

describe('providerHint', () => {
  it('fills {prefix} with LLM or EMBEDDING', () => {
    expect(providerHint('rate_limited', 'LLM')).toContain('LLM_API_KEY');
    expect(providerHint('rate_limited', 'LLM')).not.toContain('{prefix}');
    expect(providerHint('rate_limited', 'EMBEDDING')).toContain('EMBEDDING_API_KEY');
  });

  it('fills every placeholder in every category', () => {
    for (const category of PROVIDER_CATEGORIES) for (const prefix of ['LLM', 'EMBEDDING'] as const) expect(providerHint(category, prefix)).not.toContain('{');
  });
});

describe('describeFailure', () => {
  it('uses Milestone 1’s fixed message with the file’s hint for a provider category', () => {
    expect(describeFailure('not_authorized', null, 'LLM')).toEqual({
      message: FAILURE_MESSAGES.not_authorized,
      hint: providerHint('not_authorized', 'LLM'),
    });
  });

  it('uses the file’s message and hint for a job category', () => {
    for (const category of ['cap_reached', 'timed_out', 'worker_lost', 'job_error'] as const) {
      expect(describeFailure(category, null, 'LLM')).toEqual(loadFailures().job[category]);
    }
  });

  it('chooses the “lower than one request” text for cap_reached with that detail', () => {
    expect(describeFailure('cap_reached', 'cap_below_one_request', 'LLM')).toEqual(loadFailures().job.cap_below_one_request);
    expect(describeFailure('cap_reached', 'cap_below_one_request', 'LLM').message).toMatch(/lower than one request/);
  });
});

describe('the categories of ingestion (Phase 3 Milestone 3)', () => {
  const NEW = ['unsupported_type', 'encrypted', 'damaged', 'no_text_found', 'too_large', 'too_large_unpacked', 'unreadable', 'storage_unavailable', 'document_space_full'] as const;

  it('gives every category a job can end with a message and a hint of its own, with nothing left to fill', () => {
    for (const category of JOB_FAILURE_CATEGORIES) {
      const { message, hint } = describeFailure(category, null, 'EMBEDDING');
      expect(message.length, category).toBeGreaterThan(10);
      expect(hint.length, category).toBeGreaterThan(10);
      expect(`${message} ${hint}`, category).not.toMatch(/[{}]/);
    }
  });

  it('reads the new categories from the file, not from Milestone 1’s layer', () => {
    for (const category of NEW) expect(describeFailure(category, null, 'LLM')).toEqual(loadFailures().job[category]);
  });

  it('tells a person what to do about each failure the document causes', () => {
    expect(describeFailure('encrypted', null, 'LLM').hint).toMatch(/unprotected|password/i);
    expect(describeFailure('no_text_found', null, 'LLM').hint).toMatch(/image|scan|text/i);
    expect(describeFailure('unsupported_type', null, 'LLM').hint).toMatch(/\.docx|\.pdf|upload/i);
  });

  it('tells the operator what to do about a full document space and about storage', () => {
    expect(describeFailure('document_space_full', null, 'LLM').hint).toContain('DOCUMENT_SPACE');
    expect(describeFailure('storage_unavailable', null, 'LLM').hint).toMatch(/STORAGE_|storage/);
  });
});

describe('the details that name a bound (FR-011)', () => {
  it('says which limit a document passed: time or memory for unreadable, pages or characters for too large', () => {
    const time = describeFailure('unreadable', 'time', 'LLM');
    const memory = describeFailure('unreadable', 'memory', 'LLM');
    const pages = describeFailure('too_large', 'pages', 'LLM');
    const chars = describeFailure('too_large', 'chars', 'LLM');
    expect(time.message).toMatch(/time/i);
    expect(time.hint).toContain('EXTRACT_TIME_LIMIT');
    expect(memory.message).toMatch(/memory/i);
    expect(memory.hint).toContain('EXTRACT_MEMORY_MB');
    expect(pages.message).toMatch(/pages/i);
    expect(pages.hint).toContain('EXTRACT_MAX_PAGES');
    expect(chars.message).toMatch(/characters/i);
    expect(chars.hint).toContain('SOURCE_MAX_CHARS');
    expect(new Set([time.message, memory.message, pages.message, chars.message]).size).toBe(4);
  });

  it('falls back to the category’s own text when there is no detail, or the detail is not its own', () => {
    expect(describeFailure('unreadable', null, 'LLM')).toEqual(loadFailures().job.unreadable);
    expect(describeFailure('too_large', null, 'LLM')).toEqual(loadFailures().job.too_large);
    expect(describeFailure('damaged', 'time', 'LLM')).toEqual(loadFailures().job.damaged);
    expect(describeFailure('unreadable', 'pages', 'LLM')).toEqual(loadFailures().job.unreadable);
    expect(describeFailure('too_large', 'cap_below_one_request', 'LLM')).toEqual(loadFailures().job.too_large);
  });

  it('leaves the cap’s detail where Milestone 2 put it', () => {
    expect(describeFailure('cap_reached', 'cap_below_one_request', 'LLM')).toEqual(loadFailures().job.cap_below_one_request);
  });
});

describe('a hint that depends on the job kind', () => {
  it('says that an embedding model does not accept the chunk size, for ingestion and for a refresh', () => {
    for (const kind of ['ingest_source', 'refresh_embeddings'] as const) {
      const { message, hint } = describeFailure('input_too_large', null, 'EMBEDDING', kind);
      expect(message).toBe(FAILURE_MESSAGES.input_too_large);
      expect(hint).toContain('2,000 characters');
      expect(hint).toContain('2,048');
      expect(hint).not.toBe(providerHint('input_too_large', 'EMBEDDING'));
    }
  });

  it('keeps Milestone 1’s hint for the provider check, and when no kind is given', () => {
    expect(describeFailure('input_too_large', null, 'LLM', 'provider_check').hint).toBe(providerHint('input_too_large', 'LLM'));
    expect(describeFailure('input_too_large', null, 'LLM').hint).toBe(providerHint('input_too_large', 'LLM'));
  });

  it('does not change a category that has no hint of its own for the kind', () => {
    expect(describeFailure('rate_limited', null, 'EMBEDDING', 'ingest_source').hint).toBe(providerHint('rate_limited', 'EMBEDDING'));
  });
});

describe('what a source shows when its ingestion was cancelled', () => {
  it('has a message and a hint of its own, which blame nobody', () => {
    const { message, hint } = describeSourceCancelled();
    expect(message).toMatch(/cancel/i);
    expect(hint).toMatch(/retry/i);
    expect(`${message} ${hint}`).not.toMatch(/error|fail|provider|key/i);
  });
});

describe('parseFailuresFile, for the sections of Milestone 3', () => {
  it('refuses a file without the kinds, or without the source section', () => {
    const noKinds = toYaml(valid()).replace(/kinds:[\s\S]*?(?=source:)/, '');
    expect(() => parseFailuresFile(noKinds)).toThrow();
    const noSource = toYaml(valid()).replace(/source:[\s\S]*$/, '');
    expect(() => parseFailuresFile(noSource)).toThrow();
  });

  it('refuses a kind that is not one of the two, and a category under a kind that has no hint of its own', () => {
    const unknownKind = valid();
    unknownKind.kinds.provider_check = { input_too_large: 'h' };
    expect(() => parseFailuresFile(toYaml(unknownKind))).toThrow();
    const unknownCategory = valid();
    unknownCategory.kinds.ingest_source = { encrypted: 'h' };
    expect(() => parseFailuresFile(toYaml(unknownCategory))).toThrow();
  });

  it('refuses a missing hint for a kind, and an empty one', () => {
    const missing = valid();
    missing.kinds.ingest_source = {};
    expect(() => parseFailuresFile(toYaml(missing))).toThrow();
    const empty = valid();
    empty.kinds.refresh_embeddings = { input_too_large: '' };
    expect(() => parseFailuresFile(toYaml(empty))).toThrow();
  });

  it('refuses an unknown entry under source, and a missing cancelled', () => {
    const extra = valid();
    extra.source.failed = { message: 'm', hint: 'h' };
    expect(() => parseFailuresFile(toYaml(extra))).toThrow();
    const missing = valid();
    delete missing.source.cancelled;
    expect(() => parseFailuresFile(toYaml(missing))).toThrow();
  });

  it('applies the same rules to the new texts: no other placeholder, no address', () => {
    const placeholder = valid();
    placeholder.kinds.ingest_source = { input_too_large: 'Raise {limit}.' };
    expect(() => parseFailuresFile(toYaml(placeholder))).toThrow(/placeholder/);
    const link = valid();
    link.source.cancelled = { message: 'm', hint: 'See https://example.com' };
    expect(() => parseFailuresFile(toYaml(link))).toThrow(/address/);
    const document = valid();
    document.job.encrypted = { message: 'm', hint: 'Open http://example.com/help' };
    expect(() => parseFailuresFile(toYaml(document))).toThrow(/address/);
  });

  it('refuses a missing detail entry, which would leave a bound unnamed', () => {
    const missing = valid();
    delete missing.job.unreadable_memory;
    expect(() => parseFailuresFile(toYaml(missing))).toThrow();
    const missingPages = valid();
    delete missingPages.job.too_large_pages;
    expect(() => parseFailuresFile(toYaml(missingPages))).toThrow();
  });
});

describe('the shipped file’s new texts', () => {
  const FILE = readFileSync(new URL('../../data/failures.yaml', import.meta.url), 'utf8');

  it('names no file, no path and no content, only settings and what to do', () => {
    expect(FILE).not.toMatch(/\.\.\/|\/tmp\/|\/app\/|C:\\\\/);
  });

  it('keeps the sentence that Scrylux does not read text from images, in the hint for a scan', () => {
    expect(loadFailures().job.no_text_found.hint).toMatch(/image|scan/i);
  });

  it('gives the file a header that points to the rules', () => {
    expect(FILE.split('\n')[0]).toMatch(/^#/);
    expect(FILE).toContain('apps/api/test/jobs/failures.test.ts');
  });
});
