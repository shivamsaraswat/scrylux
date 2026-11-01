import type { JobProgress, JobRecord, JobTotals } from '@scrylux/core';

// How a job is written on the Jobs pages (Phase 3 Milestone 2, contracts/ui.md). Everything here returns plain text; the
// pages render it as text, so nothing the API sends can become markup (FR-066).

export const KIND_LABEL: Record<JobRecord['kind'], string> = { provider_check: 'Provider check', ingest_source: 'Process a document', refresh_embeddings: 'Refresh embeddings' };

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
