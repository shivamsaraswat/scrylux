import { readFileSync } from 'node:fs';
import { FAILURE_MESSAGES, type FailureCategory } from '@scrylux/llm';
import { describe, expect, it } from 'vitest';
import { describeFailure, loadFailures, parseFailuresFile, providerHint } from '../../src/jobs/failures.js';

// apps/api/data/failures.yaml: the message and hint of every failure a job can show, which the operator's check command
// shares (Phase 3 Milestone 2, FR-064, contracts/data-files.md).

const PROVIDER_CATEGORIES = Object.keys(FAILURE_MESSAGES) as FailureCategory[];
const JOB_KEYS = ['cap_below_one_request', 'cap_reached', 'job_error', 'timed_out', 'worker_lost'];

const FILE_TEXT = readFileSync(new URL('../../data/failures.yaml', import.meta.url), 'utf8');

/** A valid file in memory, to change one thing at a time. */
function valid(): { provider: Record<string, string>; job: Record<string, { message: string; hint: string }> } {
  return {
    provider: Object.fromEntries(PROVIDER_CATEGORIES.map((c) => [c, `Check {prefix}_MODEL for ${c}.`])),
    job: Object.fromEntries(JOB_KEYS.map((k) => [k, { message: `The ${k} message.`, hint: `The ${k} hint.` }])),
  };
}

const toYaml = (file: ReturnType<typeof valid>): string =>
  [
    'provider:',
    ...Object.entries(file.provider).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`),
    'job:',
    ...Object.entries(file.job).flatMap(([k, v]) => [`  ${k}:`, `    message: ${JSON.stringify(v.message)}`, `    hint: ${JSON.stringify(v.hint)}`]),
  ].join('\n');

describe('the shipped file', () => {
  it('has a hint for each of Milestone 1’s eleven categories', () => {
    expect(PROVIDER_CATEGORIES).toHaveLength(11);
    const { provider } = loadFailures();
    expect(Object.keys(provider).sort()).toEqual([...PROVIDER_CATEGORIES].sort());
    for (const text of Object.values(provider)) expect(text.length).toBeGreaterThan(10);
  });

  it('has a message and a hint for cap_reached, cap_below_one_request, timed_out, worker_lost and job_error, and no other key', () => {
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
