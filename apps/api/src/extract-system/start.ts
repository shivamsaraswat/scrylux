import type { DraftPath, ExtractionStatus, StartRefusal } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import type { LlmStatus } from '@scrylux/llm';
import { sql, type Kysely } from 'kysely';
import type { ExtractionConfig } from './config.js';
import { loadSourceFacts, readyFacts } from './load.js';
import { choosePath, staleEmbeddings } from './path.js';

// What a start would do right now, and why not (Phase 3 Milestone 4, FR-002 to FR-004, FR-015, FR-042, FR-045, research #11). One function
// decides, in the order of contracts/http-api.md, and the status route and the start route both call it, so what the page offers is what a
// start accepts. The messages are fixed text built from counts and the settings' names: they hold no source name and no text (SC-009).

type Db = Kysely<Database>;

export type Assessment = ExtractionStatus['start'];

/** The providers and settings an assessment depends on, as the API sees them: it holds no provider key and sends no request. */
export interface StartContext {
  providers: Pick<LlmStatus, 'generation' | 'embedding'>;
  caps: { tokenCap: number; costCapUsd: number };
  extraction: ExtractionConfig;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const refuse = (reason: StartRefusal, message: string, sourceIds: string[] = []): Assessment => ({ offered: false, reason, message, source_ids: sourceIds });

/** The threat model's latest extraction, with what the retry rules compare (FR-045). */
export interface LatestExtraction {
  id: string;
  state: string;
  failureCategory: string | null;
  tokenCap: number;
  costCapUsd: number;
  result: { context_chars?: number; max_output_tokens?: number } | null;
  /** The model the job last asked, or null if it asked none. */
  lastModel: string | null;
}

export async function loadLatestExtraction(db: Db, threatModelId: string): Promise<LatestExtraction | undefined> {
  const { rows } = await sql<{
    id: string;
    state: string;
    failure_category: string | null;
    token_cap: string;
    cost_cap_usd: string;
    result: LatestExtraction['result'];
    last_model: string | null;
  }>`
    SELECT j.id, j.state, j.failure_category, j.token_cap, j.cost_cap_usd, j.result,
           (SELECT u.model FROM job_usage u WHERE u.job_id = j.id ORDER BY u.id DESC LIMIT 1) AS last_model
    FROM jobs j WHERE j.threat_model_id = ${threatModelId}::uuid AND j.kind = 'extract_system'
    ORDER BY j.queued_at DESC, j.id DESC LIMIT 1`.execute(db);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { id: row.id, state: row.state, failureCategory: row.failure_category, tokenCap: Number(row.token_cap), costCapUsd: Number(row.cost_cap_usd), result: row.result, lastModel: row.last_model };
}

/**
 * Why a retry of the latest extraction's failure would not help, or undefined when a start may go ahead (FR-045): the cap has not been
 * raised, the budget and the model are what they were, or the output limit and the model are. So a start never spends a new budget on a failure
 * that is certain to repeat. "Embeddings out of date" is not decided here: it is the check of the path above, which looks at the sources now.
 */
function wouldRepeat(latest: LatestExtraction | undefined, context: StartContext): string | undefined {
  if (latest === undefined || latest.state !== 'failed') return undefined;
  const model = context.providers.generation?.model ?? null;
  switch (latest.failureCategory) {
    case 'cap_reached':
      return context.caps.tokenCap > latest.tokenCap || context.caps.costCapUsd > latest.costCapUsd
        ? undefined
        : 'Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP.';
    case 'input_too_large':
      return latest.result?.context_chars === context.extraction.contextChars && latest.lastModel === model
        ? 'The input was too large for this model. Ask the operator to lower EXTRACTION_CONTEXT_CHARS or choose another model.'
        : undefined;
    case 'output_limit_reached':
      return latest.result?.max_output_tokens === context.extraction.maxOutputTokens && latest.lastModel === model
        ? 'The draft was larger than the output limit. Ask the operator to raise EXTRACTION_MAX_OUTPUT_TOKENS.'
        : undefined;
    default:
      return undefined;
  }
}

export interface StartAssessment {
  start: Assessment;
  latest: LatestExtraction | undefined;
  /** Every chunk of the ready sources: what the whole path would read. */
  chunksAvailable: number;
}

export async function assessStart(db: Db, threatModelId: string, context: StartContext): Promise<StartAssessment> {
  const latest = await loadLatestExtraction(db, threatModelId);
  const facts = await loadSourceFacts(db, threatModelId);
  const ready = readyFacts(facts);
  const chunksAvailable = ready.reduce((sum, source) => sum + source.chunkCount, 0);
  const done = (start: Assessment): StartAssessment => ({ start, latest, chunksAvailable });

  if (context.providers.generation === null) return done(refuse('no_generation_provider', 'Extraction needs a generation provider. Ask the operator to set LLM_PROVIDER.'));
  if (latest !== undefined && (latest.state === 'queued' || latest.state === 'running')) {
    return done(refuse('extraction_active', 'An extraction of this threat model is already queued or running.'));
  }
  const unfinished = facts.filter((source) => source.status === 'waiting' || source.status === 'processing');
  if (unfinished.length > 0) {
    const n = unfinished.length;
    return done(
      refuse(
        'sources_processing',
        `${n} ${plural(n, 'source of this threat model is', 'sources of this threat model are')} still being processed. Wait until ${plural(n, 'it is', 'they are')} ready.`,
        unfinished.map((source) => source.id),
      ),
    );
  }
  if (ready.length === 0) return done(refuse('no_ready_source', 'Extraction needs at least one ready source. Add a document on the Sources tab.'));

  const path: DraftPath = choosePath(ready, context.extraction.contextChars);
  if (path === 'retrieval') {
    const embedding = context.providers.embedding;
    if (embedding === null) {
      return done(
        refuse('no_embedding_provider', 'These sources are larger than the extraction budget, and choosing among them needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER.'),
      );
    }
    const stale = staleEmbeddings(ready, { model: embedding.model });
    if (stale.length > 0) {
      const n = stale.length;
      return done(
        refuse(
          'embeddings_out_of_date',
          `These sources are larger than the extraction budget, and ${n} of them ${plural(n, 'has', 'have')} embeddings from another model. Refresh ${plural(n, 'its', 'their')} embeddings on the Sources tab.`,
          stale,
        ),
      );
    }
  }

  const repeat = wouldRepeat(latest, context);
  if (repeat !== undefined) return done(refuse('would_repeat', repeat));

  const { rows } = await sql<{ has: boolean }>`SELECT EXISTS (SELECT 1 FROM drafts WHERE threat_model_id = ${threatModelId}::uuid) AS has`.execute(db);
  return done({ offered: true, path, replaces_draft: rows[0]?.has === true });
}
