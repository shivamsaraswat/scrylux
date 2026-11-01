import type { JobFailureCategory, JobFailureDetail, JobKind, JobProgress, JsonValue, ProviderCheckOperation } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import type { Kysely } from 'kysely';
import type { Llm, LlmConfig, Usage } from '@scrylux/llm';
import type { ClaimedJob, RunCommit } from '../jobs/store.js';
import type { StopReason } from './stop.js';
import { runProviderCheck, type CheckResult } from '../provider-check.js';
import { ingestSource } from './ingest.js';
import { refreshEmbeddings } from './refresh.js';

// The job kinds the worker can run (Phase 3 Milestone 2, FR-013): a fixed list that ships with Scrylux. This milestone has
// one, the provider check. Each kind says whether it calls a model, and does its work through the context the run gives
// it, which is also how it is stopped: it sends nothing without `beforeRequest`, and it stops when `signal` aborts.

type JsonObject = Record<string, JsonValue>;

export interface RunContext {
  job: ClaimedJob;
  /** The database, for the kinds that read what they work on (Phase 3 Milestone 3). */
  db: Kysely<Database>;
  llm: Llm;
  llmConfig: LlmConfig;
  /** Aborts when a cancel is asked, the deadline passes, the job is lost or the worker hands it back. */
  signal: AbortSignal;
  /** Records the step the job is on (FR-015). */
  progress(progress: JobProgress): Promise<void>;
  /** Awaited before each model request; throws RunStopped to stop the job (the gate and the caps, FR-042). */
  beforeRequest(request: { operation: 'generate' | 'embed'; inputChars: number }): Promise<void>;
  /** Stores the usage record of a request that was made, and returns its id (FR-050). */
  record(usage: Usage): Promise<number>;
  /** Keeps the result so far, so that it is stored however the run ends (FR-092). */
  keep(result: JsonObject): void;
  /** Why the run was stopped, if it was: a request it abandoned is reported by the layer as cancelled whatever the reason. */
  stopReason(): StopReason | undefined;
}

export interface KindOutcome {
  result: JsonObject;
  /** Set when the kind's work ended in a failure that is not a stop; the first such failure of the run. */
  failure?: { category: JobFailureCategory; detail?: JobFailureDetail };
  /** What to write in the transaction that ends the job, when it succeeds (Phase 3 Milestone 3, research #2). */
  commit?: RunCommit;
  /** Runs after the commit has committed and the job has succeeded, for what must not happen inside a transaction. A failure is the sweep's. */
  afterCommit?: () => Promise<void>;
}

export interface Kind {
  run(context: RunContext): Promise<KindOutcome>;
}

/** How one operation of a provider check is stored: no key and no base address (FR-091). */
async function stored(context: RunContext, result: CheckResult): Promise<ProviderCheckOperation> {
  if (result.status === 'not_configured' || result.status === 'not_run' || result.config === null) return { status: result.status === 'not_run' ? 'not_run' : 'not_configured' };
  const usageId = result.usage === null ? undefined : await context.record(result.usage);
  // The layer reports a request that was abandoned as cancelled; if the job's deadline did that, the job says so (data-model.md).
  const status = result.status === 'cancelled' && context.stopReason() === 'timed_out' ? 'timed_out' : result.status;
  return {
    status,
    provider: result.config.provider,
    model: result.config.model,
    hosted: result.config.hosted,
    ...(usageId === undefined ? {} : { usage_id: usageId }),
  };
}

const providerCheck: Kind = {
  async run(context) {
    // The configuration changed between queueing and running: the API offers a check only while a provider is configured.
    if (context.llmConfig.generation === null && context.llmConfig.embedding === null) {
      const none: ProviderCheckOperation = { status: 'not_configured' };
      return { result: { generation: none, embeddings: none }, failure: { category: 'not_configured' } };
    }
    const operations: Record<'generation' | 'embeddings', ProviderCheckOperation> = {
      generation: { status: 'not_run' },
      embeddings: { status: 'not_run' },
    };
    // Whatever happens next, the result shows both operations; one that is never reached stays not_run.
    context.keep({ ...operations });
    let failure: KindOutcome['failure'];
    await runProviderCheck(context.llm, context.llmConfig, {
      signal: context.signal,
      onStart: (operation) => context.progress({ step: operation }),
      beforeRequest: (request) => context.beforeRequest(request),
      onResult: async (result) => {
        operations[result.operation] = await stored(context, result);
        context.keep({ ...operations });
        // The first operation that failed names the job's failure. A request ended by a stop is the run's to explain.
        if (failure === undefined && result.status !== 'ok' && result.status !== 'not_configured' && result.status !== 'not_run' && result.status !== 'cancelled') {
          failure = { category: result.status };
        }
      },
    });
    return { result: { ...operations }, ...(failure === undefined ? {} : { failure }) };
  },
};

export const kinds: Record<JobKind, Kind> = { provider_check: providerCheck, ingest_source: ingestSource, refresh_embeddings: refreshEmbeddings };
