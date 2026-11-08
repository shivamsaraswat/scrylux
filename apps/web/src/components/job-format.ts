import type { ExtractionResult, JobProgress, JobRecord, JobTotals } from '@scrylux/core';

// How a job is written on the Jobs pages (Phase 3 Milestone 2, contracts/ui.md). Everything here returns plain text; the
// pages render it as text, so nothing the API sends can become markup (FR-066).

export const KIND_LABEL: Record<JobRecord['kind'], string> = {
  provider_check: 'Provider check',
  ingest_source: 'Process a document',
  refresh_embeddings: 'Refresh embeddings',
  extract_system: 'System extraction',
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The state as a person reads it: a job whose worker was lost, or that is being cancelled, says so (FR-062, FR-030). */
export function stateLabel(job: Pick<JobRecord, 'state' | 'cancel_requested' | 'worker_lost'>): string {
  if (job.worker_lost) return 'Worker lost';
  if (job.cancel_requested) return 'Cancelling…';
  return capitalize(job.state);
}

const STEP_LABEL: Record<JobProgress['step'], string> = {
  generation: 'Checking generation',
  embeddings: 'Checking embeddings',
  extract: 'Reading the document',
  chunk: 'Splitting the text',
  embed: 'Embedding the chunks',
  select: 'Choosing the chunks to read',
  generate: 'Asking the model for a draft',
  store: 'Checking and storing the draft',
};

export function progressLabel(progress: JobProgress): string {
  const step = STEP_LABEL[progress.step];
  return progress.done !== undefined && progress.total !== undefined ? `${step} (${progress.done} of ${progress.total})` : step;
}

export const failureWords = (category: string): string => category.replace(/_/g, ' ');

/** US dollars with the digits that matter: 0.0021 is $0.0021 and 5 is $5. */
export const dollars = (amount: number): string => `$${parseFloat(amount.toFixed(6))}`;

/** The cost of a job, or that it is unknown with the least it cost, never zero for an unknown price (FR-043). */
export function costText(totals: Pick<JobTotals, 'cost_usd' | 'cost_known_usd'>): string {
  if (totals.cost_usd !== null) return dollars(totals.cost_usd);
  return totals.cost_known_usd > 0 ? `cost unknown (at least ${dollars(totals.cost_known_usd)})` : 'cost unknown';
}

export const tokenText = (totals: Pick<JobTotals, 'input_tokens' | 'output_tokens' | 'tokens_estimated'>): string =>
  `${totals.input_tokens} in, ${totals.output_tokens} out${totals.tokens_estimated ? ' (estimated)' : ''}`;

export const time = (iso: string): string => new Date(iso).toLocaleString();

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What an extraction read, in words (Phase 3 Milestone 4, FR-014): all of the chunks, or part of them chosen by relevance, so a
 * person can tell a component that is missing from the documents from one that was not read. Shown on the job's page and on the
 * Draft tab.
 */
export function readSummary(read: Pick<ExtractionResult, 'path' | 'chunks_read' | 'chunks_available' | 'sources_read'>): string {
  const sources = plural(read.sources_read, 'source', 'sources');
  return read.path === 'whole'
    ? `Read all ${plural(read.chunks_read, 'chunk', 'chunks')} of ${sources}`
    : `Read ${read.chunks_read} of ${plural(read.chunks_available, 'chunk', 'chunks')} of ${sources}, chosen by relevance`;
}

/** The sources an extraction left out because they were not ready (FR-004), or null when it left none out. */
export function leftOutText(count: number): string | null {
  return count === 0 ? null : `${plural(count, 'source', 'sources')} left out because ${count === 1 ? 'it was' : 'they were'} not ready`;
}

/** What an extraction proposed, as counts. */
export const itemCountsText = (items: ExtractionResult['items']): string =>
  [plural(items.elements, 'element', 'elements'), plural(items.assets, 'asset', 'assets'), plural(items.assumptions, 'assumption', 'assumptions')].join(', ');
