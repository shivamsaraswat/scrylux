import { readFileSync } from 'node:fs';
import type { JobFailureCategory, JobFailureDetail, JobKind } from '@scrylux/core';
import { FAILURE_MESSAGES, type FailureCategory } from '@scrylux/llm';
import { isAlias, isNode, parseDocument, visit } from 'yaml';
import { z } from 'zod';

// The message and hint of every failure a job can show (Phase 3 Milestone 2, FR-064), read from apps/api/data/failures.yaml
// (Principle IV). The operator's check command prints the same hints, so the command and the UI say the same thing.
// A message and a hint are fixed text: never a raw provider error, a key, a base address or any content.

export type Prefix = 'LLM' | 'EMBEDDING';

const PLACEHOLDER = '{prefix}';
const PROVIDER_CATEGORIES = Object.keys(FAILURE_MESSAGES) as FailureCategory[];

/** A fixed text, with {prefix} as its only placeholder and no address. */
const text = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (/[{}]/.test(value.replaceAll(PLACEHOLDER, ''))) ctx.addIssue({ code: 'custom', message: `uses a placeholder other than ${PLACEHOLDER}` });
    if (/https?:\/\//i.test(value)) ctx.addIssue({ code: 'custom', message: 'holds an address, which a hint must not carry' });
  });

const entry = z.strictObject({ message: text, hint: text });

const fileSchema = z.strictObject({
  provider: z.strictObject(Object.fromEntries(PROVIDER_CATEGORIES.map((category) => [category, text])) as Record<FailureCategory, typeof text>),
  job: z.strictObject({
    cap_reached: entry,
    cap_below_one_request: entry,
    timed_out: entry,
    worker_lost: entry,
    job_error: entry,
    unsupported_type: entry,
    encrypted: entry,
    damaged: entry,
    no_text_found: entry,
    too_large: entry,
    too_large_pages: entry,
    too_large_chars: entry,
    too_large_unpacked: entry,
    unreadable: entry,
    unreadable_time: entry,
    unreadable_memory: entry,
    storage_unavailable: entry,
    document_space_full: entry,
  }),
  // A hint for one of Milestone 1's categories that is different for this kind of job.
  kinds: z.strictObject({
    ingest_source: z.strictObject({ input_too_large: text }),
    refresh_embeddings: z.strictObject({ input_too_large: text }),
  }),
  // What a source shows when its ingestion was cancelled: its category is not a job's (FR-044).
  source: z.strictObject({ cancelled: entry }),
});

export type Failures = z.infer<typeof fileSchema>;

/**
 * Strict YAML 1.2, the way Milestone 1 reads its data files: the core schema, and duplicate keys, anchors, aliases and
 * several documents are refused. Then the shape, which refuses an unknown or missing key and any text with a placeholder
 * other than {prefix} or an address.
 */
export function parseFailuresFile(source: string): Failures {
  const doc = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true });
  const problems = [...doc.errors, ...doc.warnings].map((problem) => problem.message.split('\n')[0] ?? 'invalid YAML');
  if (problems.length === 0) {
    visit(doc, (_key, node) => {
      if (isAlias(node)) problems.push('aliases are not allowed');
      else if (isNode(node) && node.anchor) problems.push('anchors are not allowed');
    });
  }
  if (problems.length > 0) throw new Error(`data/failures.yaml is not valid YAML: ${problems.join('; ')}`);
  const parsed = fileSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'the file'} ${issue.message}`);
    throw new Error(`data/failures.yaml is not valid: ${where.join('; ')}`);
  }
  return parsed.data;
}

let loaded: Failures | undefined;

/** The shipped file, read once. It sits next to `src` and `dist`, so the same path serves both. */
export function loadFailures(): Failures {
  loaded ??= parseFailuresFile(readFileSync(new URL('../../data/failures.yaml', import.meta.url), 'utf8'));
  return loaded;
}

/** The hint for one of Milestone 1's categories, naming the settings of the operation that failed (FR-046). */
export function providerHint(category: FailureCategory, prefix: Prefix): string {
  return loadFailures().provider[category].replaceAll(PLACEHOLDER, prefix);
}

const isProviderCategory = (category: JobFailureCategory): category is FailureCategory & JobFailureCategory => category in FAILURE_MESSAGES;

/**
 * The message and hint a job shows for its failure. `detail` chooses the text that names a bound: the cap that was lower than
 * one request (FR-044), the limit a document passed (FR-011). A detail that is not the category's own is ignored. `kind`
 * chooses a hint that is different for ingestion and refresh, for a model that refuses the chunk size.
 */
export function describeFailure(
  category: JobFailureCategory,
  detail: JobFailureDetail | null,
  prefix: Prefix,
  kind?: JobKind,
): { message: string; hint: string } {
  const { job, kinds } = loadFailures();
  switch (category) {
    case 'cap_reached':
      return detail === 'cap_below_one_request' ? job.cap_below_one_request : job.cap_reached;
    case 'unreadable':
      return detail === 'time' ? job.unreadable_time : detail === 'memory' ? job.unreadable_memory : job.unreadable;
    case 'too_large':
      return detail === 'pages' ? job.too_large_pages : detail === 'chars' ? job.too_large_chars : job.too_large;
    case 'timed_out':
    case 'worker_lost':
    case 'job_error':
    case 'unsupported_type':
    case 'encrypted':
    case 'damaged':
    case 'no_text_found':
    case 'too_large_unpacked':
    case 'storage_unavailable':
    case 'document_space_full':
      return job[category];
    default:
      break;
  }
  if (!isProviderCategory(category)) return job.job_error;
  if (category === 'input_too_large' && (kind === 'ingest_source' || kind === 'refresh_embeddings')) {
    return { message: FAILURE_MESSAGES.input_too_large, hint: kinds[kind].input_too_large };
  }
  return { message: FAILURE_MESSAGES[category], hint: providerHint(category, prefix) };
}

/** What a source shows when its ingestion was cancelled from the Jobs page (FR-044). */
export const describeSourceCancelled = (): { message: string; hint: string } => loadFailures().source.cancelled;
