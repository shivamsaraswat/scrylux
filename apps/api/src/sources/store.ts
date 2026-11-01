import { createHash } from 'node:crypto';
import type { ChunkPage, ChunkPageQuery, JobFailureCategory, JobFailureDetail, JobKind, JobProgress, SourceFailure, SourceList, SourceRecord, SourceType } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { describeFailure, describeSourceCancelled } from '../jobs/failures.js';
import { JobLimitError, cancelJob, enqueueIngestion, lockAccount, type IngestionSettings } from '../jobs/store.js';
import { StorageUnavailable, newOriginalKey, type Storage } from '../storage/index.js';
import type { SourceConfig } from './config.js';

// Sources (Phase 3 Milestone 3, specs/phase-3/milestone-3-ingestion/data-model.md, research #1, #2, #9, #12, #14). The API adds,
// lists, reads, deletes, retries and refreshes them; the worker ingests them (worker/ingest.ts). A source's status is read
// from its latest ingestion job while it is not ready, so nothing here keeps a status that a sweep, a cancel or a deletion could
// leave behind.
//
// Locks, in one order everywhere: the threat model's row, or the source's, then the account (jobs/store.ts lockAccount), then
// the install's document space, then job rows. The worker's commit takes the source, the space, then the job.

type Db = Kysely<Database>;

/** What the store needs to know about the install, passed in so that a test can choose it. */
export interface SourcesContext {
  storage: Storage;
  config: SourceConfig;
  /** The caps copied onto a new job, and the account's limit on ingestion jobs (FR-043). */
  jobs: IngestionSettings;
  /** The configured embedding model, or null when no embedding provider is configured (FR-030). */
  embeddingModel: string | null;
}

/** A request the store refuses, with the HTTP status the route answers (contracts/http-api.md). The message is fixed text. */
export class SourceRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 503 | 507,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SourceRefusal';
  }
}

const MESSAGES = {
  noProvider: 'Adding documents needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER.',
  noThreatModel: 'Threat model not found',
  full: 'The document space of this install is full. Delete sources, or ask the operator to raise DOCUMENT_SPACE.',
  storage: 'Document storage is unavailable. Ask the operator to check it, then try again.',
  notReady: 'This source is not ready yet.',
  fromTheDocument: 'This failure comes from the document itself. Fix the document and add it again.',
  sameCap: 'Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP.',
  chunkSize: "This embedding model does not accept Scrylux's chunk size. Ask the operator to choose another.",
  notFailed: 'This source has not failed, so there is nothing to retry.',
  current: 'The embeddings of this source are current.',
  refreshing: 'This source is already being refreshed.',
} as const;

// The key of the lock on the install's document space, in a key space of its own (FR-009, research #12).
const SPACE_LOCK_NAMESPACE = 0x646f63;
export const lockSpace = (trx: Transaction<Database>): Promise<unknown> => sql`SELECT pg_advisory_xact_lock(${SPACE_LOCK_NAMESPACE}::int, 1)`.execute(trx);

/** What every source stores, text and embeddings counted (research #12). */
export async function usedBytes(db: Db): Promise<number> {
  const { rows } = await sql<{ used: string }>`SELECT coalesce(sum(stored_bytes), 0)::text AS used FROM sources`.execute(db);
  return Number(rows[0]?.used ?? 0);
}

// ---- Reading ----------------------------------------------------------------------------------------------------------

interface JobFacts {
  id: string | null;
  state: string | null;
  progress: JobProgress | null;
  failure_category: JobFailureCategory | null;
  failure_detail: JobFailureDetail | null;
  token_cap: string | null;
  cost_cap_usd: string | null;
  /** The model of the last usage record the job stored: the one that answered or refused. */
  last_model: string | null;
}

interface SourceRow {
  id: string;
  threat_model_id: string;
  name: string;
  type: SourceType;
  size_bytes: number;
  added_at: Date;
  user_id: number;
  username: string;
  ready_at: Date | null;
  text_chars: number | null;
  chunk_count: number | null;
  pages_without_text: number | null;
  embedding_model: string | null;
  embedding_dimension: number | null;
  ing: JobFacts;
  ref: JobFacts;
}

const jobFacts = (kind: JobKind): ReturnType<typeof sql> => sql`
  LEFT JOIN LATERAL (
    SELECT j.id, j.state, j.progress, j.failure_category, j.failure_detail, j.token_cap, j.cost_cap_usd,
           (SELECT model FROM job_usage WHERE job_id = j.id ORDER BY id DESC LIMIT 1) AS last_model
    FROM jobs j WHERE j.source_id = s.id AND j.kind = ${kind} ORDER BY j.queued_at DESC, j.id DESC LIMIT 1
  ) ${sql.id(kind === 'ingest_source' ? 'ing' : 'ref')} ON true`;

const SOURCE_SELECT = sql`
  SELECT s.id, s.threat_model_id, s.name, s.type, s.size_bytes, s.added_at, u.id AS user_id, u.username,
         s.ready_at, s.text_chars, s.chunk_count, s.pages_without_text, s.embedding_model, s.embedding_dimension,
         to_jsonb(ing.*) AS ing, to_jsonb(ref.*) AS ref
  FROM sources s
  JOIN users u ON u.id = s.added_by
  ${jobFacts('ingest_source')}
  ${jobFacts('refresh_embeddings')}`;

const FROM_THE_DOCUMENT: readonly JobFailureCategory[] = ['unsupported_type', 'encrypted', 'damaged', 'no_text_found', 'too_large', 'too_large_unpacked'];

/** Why a retry of this job's failure would not help, or undefined when it may be tried (FR-045). */
function retryProblem(job: JobFacts, ctx: SourcesContext): string | undefined {
  if (ctx.embeddingModel === null) return MESSAGES.noProvider;
  const category = job.failure_category;
  if (category === null) return undefined;
  if (FROM_THE_DOCUMENT.includes(category)) return MESSAGES.fromTheDocument;
  if (category === 'cap_reached') {
    const higher = ctx.jobs.tokenCap > Number(job.token_cap) || ctx.jobs.costCapUsd > Number(job.cost_cap_usd);
    return higher ? undefined : MESSAGES.sameCap;
  }
  if (category === 'input_too_large') return job.last_model !== null && job.last_model === ctx.embeddingModel ? MESSAGES.chunkSize : undefined;
  return undefined;
}

function failureOf(job: JobFacts, kind: JobKind, ctx: SourcesContext): SourceFailure {
  if (job.state === 'cancelled') return { category: 'cancelled', ...describeSourceCancelled(), retryable: ctx.embeddingModel !== null };
  const category = job.failure_category ?? 'job_error';
  return { category, ...describeFailure(category, job.failure_detail, 'EMBEDDING', kind), retryable: retryProblem(job, ctx) === undefined };
}

const hasJob = (job: JobFacts | null): job is JobFacts => job !== null && job.id !== null;
const progressOf = (job: JobFacts): { step: 'extract' | 'chunk' | 'embed'; done?: number; total?: number } | null => {
  const step = job.progress?.step;
  return step === 'extract' || step === 'chunk' || step === 'embed' ? { step, ...(job.progress?.done === undefined ? {} : { done: job.progress.done }), ...(job.progress?.total === undefined ? {} : { total: job.progress.total }) } : null;
};

function toRecord(row: SourceRow, ctx: SourcesContext): SourceRecord {
  const base = {
    id: row.id,
    threat_model_id: row.threat_model_id,
    name: row.name,
    type: row.type,
    size_bytes: row.size_bytes,
    added_by: { id: row.user_id, username: row.username },
    added_at: row.added_at.toISOString(),
  };
  const ing = hasJob(row.ing) ? row.ing : null;
  const ref = hasJob(row.ref) ? row.ref : null;

  if (row.ready_at !== null) {
    const model = row.embedding_model as string;
    const state = ctx.embeddingModel === null ? 'no_provider' : ctx.embeddingModel === model ? 'current' : 'out_of_date';
    const active = ref !== null && (ref.state === 'queued' || ref.state === 'running');
    const failedRefresh = ref !== null && (ref.state === 'failed' || ref.state === 'cancelled');
    return {
      ...base,
      status: 'ready',
      progress: null,
      failure: null,
      ready: {
        at: row.ready_at.toISOString(),
        text_chars: row.text_chars as number,
        chunk_count: row.chunk_count as number,
        pages_without_text: row.pages_without_text,
        embedding: { model, dimension: row.embedding_dimension as number, state },
      },
      refresh: active ? { state: ref.state as 'queued' | 'running', progress: ref.state === 'running' ? progressOf(ref) : null } : null,
      refresh_failure: failedRefresh ? failureOf(ref, 'refresh_embeddings', ctx) : null,
      refreshable: state === 'out_of_date' && !active,
    };
  }

  const none = { ready: null, refresh: null, refresh_failure: null, refreshable: false };
  if (ing === null) return { ...base, ...none, status: 'failed', progress: null, failure: failureOf({ id: null, state: 'failed', progress: null, failure_category: 'job_error', failure_detail: null, token_cap: null, cost_cap_usd: null, last_model: null }, 'ingest_source', ctx) };
  if (ing.state === 'failed' || ing.state === 'cancelled') return { ...base, ...none, status: 'failed', progress: null, failure: failureOf(ing, 'ingest_source', ctx) };
  if (ing.state === 'running') return { ...base, ...none, status: 'processing', progress: progressOf(ing), failure: null };
  return { ...base, ...none, status: 'waiting', progress: null, failure: null };
}

async function readSources(db: Db, where: ReturnType<typeof sql>, ctx: SourcesContext): Promise<SourceRecord[]> {
  const { rows } = await sql<SourceRow>`${SOURCE_SELECT} ${where}`.execute(db);
  return rows.map((row) => toRecord({ ...row, ing: row.ing, ref: row.ref }, ctx));
}

export async function getSource(db: Db, ctx: SourcesContext, id: string): Promise<SourceRecord | undefined> {
  return (await readSources(db, sql`WHERE s.id = ${id}`, ctx))[0];
}

/** The sources of a threat model, oldest first, and the limits the add form shows (FR-004, FR-005, FR-009). */
export async function listSources(db: Db, ctx: SourcesContext, threatModelId: string): Promise<SourceList> {
  return {
    sources: await readSources(db, sql`WHERE s.threat_model_id = ${threatModelId} ORDER BY s.added_at, s.id`, ctx),
    limits: {
      max_bytes: ctx.config.maxUploadBytes,
      per_threat_model: ctx.config.sourcesPerThreatModel,
      used_bytes: await usedBytes(db),
      document_space_bytes: ctx.config.documentSpaceBytes,
    },
  };
}

/** A page of a ready source's chunks, in order, without their embeddings. Refused while the source is not ready (FR-024). */
export async function getChunks(db: Db, sourceId: string, page: ChunkPageQuery): Promise<ChunkPage | undefined> {
  const source = await db.selectFrom('sources').select('ready_at').where('id', '=', sourceId).executeTakeFirst();
  if (source === undefined) return undefined;
  if (source.ready_at === null) throw new SourceRefusal(409, MESSAGES.notReady);
  const rows = await db
    .selectFrom('chunks')
    .select(['id', 'position', 'start_offset', 'end_offset', 'text', 'page_first', 'page_last', 'line_first', 'line_last', 'heading'])
    .where('source_id', '=', sourceId)
    .orderBy('position')
    .limit(page.limit + 1)
    .offset(page.offset)
    .execute();
  return {
    chunks: rows.slice(0, page.limit).map((row) => ({
      id: row.id,
      position: row.position,
      start_offset: row.start_offset,
      end_offset: row.end_offset,
      text: row.text,
      pages: row.page_first === null || row.page_last === null ? null : { first: row.page_first, last: row.page_last },
      lines: row.line_first === null || row.line_last === null ? null : { first: row.line_first, last: row.line_last },
      heading: row.heading,
    })),
    has_more: rows.length > page.limit,
  };
}

// ---- Adding -----------------------------------------------------------------------------------------------------------

export interface AddSourceInput {
  threatModelId: string;
  accountId: number;
  name: string;
  type: SourceType;
  bytes: Buffer;
}

/** The checks that need no more than the database, for an add: run before the original is stored, and again under the locks. */
async function admit(db: Db, ctx: SourcesContext, add: { threatModelId: string; sizeBytes: number; digest: Buffer }): Promise<void> {
  if (ctx.embeddingModel === null) throw new SourceRefusal(409, MESSAGES.noProvider);
  const { rows: found } = await sql`SELECT 1 FROM threat_models WHERE id = ${add.threatModelId}`.execute(db);
  if (found.length === 0) throw new SourceRefusal(404, MESSAGES.noThreatModel);

  const { rows: same } = await sql<{ name: string; ready_at: Date | null; job_state: string | null }>`
    SELECT s.name, s.ready_at,
           (SELECT state FROM jobs WHERE source_id = s.id AND kind = 'ingest_source' ORDER BY queued_at DESC, id DESC LIMIT 1) AS job_state
    FROM sources s WHERE s.threat_model_id = ${add.threatModelId} AND s.digest = ${add.digest}`.execute(db);
  const twin = same[0];
  if (twin !== undefined) {
    const failed = twin.ready_at === null && (twin.job_state === null || twin.job_state === 'failed' || twin.job_state === 'cancelled');
    throw new SourceRefusal(409, `This document is already a source of this threat model: ${twin.name}.${failed ? ' Delete it first to add this document again.' : ''}`);
  }

  const { rows: counted } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM sources WHERE threat_model_id = ${add.threatModelId}`.execute(db);
  if ((counted[0]?.n ?? 0) >= ctx.config.sourcesPerThreatModel) {
    throw new SourceRefusal(409, `This threat model already has ${ctx.config.sourcesPerThreatModel} sources, the most allowed.`);
  }
  if ((await usedBytes(db)) + add.sizeBytes > ctx.config.documentSpaceBytes) throw new SourceRefusal(507, MESSAGES.full);
}

/** A refusal by a limit that the job store enforces, as the store's own. */
function translate(error: unknown): unknown {
  if (error instanceof JobLimitError) return new SourceRefusal(429, error.message, error.retryAfterSeconds);
  const code = (error as { code?: string } | null)?.code;
  const constraint = (error as { constraint?: string } | null)?.constraint;
  if (code === '23505' && constraint === 'sources_digest_key') return new SourceRefusal(409, 'This document is already a source of this threat model.');
  if (code === '23503' && constraint === 'sources_threat_model_id_fkey') return new SourceRefusal(404, MESSAGES.noThreatModel);
  return error;
}

/**
 * Adds a source: stores the original, then, in one transaction under the locks, checks the limits again, inserts the source and
 * queues its ingestion job. A refusal at any point removes the original it stored, so a refused add leaves nothing (FR-056).
 * The caller has checked the bytes (sniff.ts).
 */
export async function addSource(db: Db, ctx: SourcesContext, input: AddSourceInput): Promise<SourceRecord> {
  const digest = createHash('sha256').update(input.bytes).digest();
  const checked = { threatModelId: input.threatModelId, sizeBytes: input.bytes.length, digest };
  await admit(db, ctx, checked);

  const key = newOriginalKey();
  try {
    await ctx.storage.put(key, input.bytes);
  } catch (error) {
    if (error instanceof StorageUnavailable) throw new SourceRefusal(503, MESSAGES.storage, 30);
    throw error;
  }

  try {
    const id = await db.transaction().execute(async (trx) => {
      // The threat model first: adds to one threat model are counted one at a time. NO KEY UPDATE still lets the inserts that
      // refer to it through foreign keys proceed.
      const { rows } = await sql`SELECT 1 FROM threat_models WHERE id = ${input.threatModelId} FOR NO KEY UPDATE`.execute(trx);
      if (rows.length === 0) throw new SourceRefusal(404, MESSAGES.noThreatModel);
      await lockAccount(trx, input.accountId);
      await lockSpace(trx);
      await admit(trx, ctx, checked);
      const source = await trx
        .insertInto('sources')
        .values({
          threat_model_id: input.threatModelId,
          name: input.name,
          type: input.type,
          size_bytes: input.bytes.length,
          digest,
          added_by: input.accountId,
          original_key: key,
          stored_bytes: input.bytes.length,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await enqueueIngestion(trx, { kind: 'ingest_source', sourceId: source.id, threatModelId: input.threatModelId, accountId: input.accountId }, ctx.jobs);
      return source.id;
    });
    return (await getSource(db, ctx, id)) as SourceRecord;
  } catch (error) {
    await ctx.storage.delete(key).catch(() => undefined);
    throw translate(error);
  }
}

// ---- Deleting ---------------------------------------------------------------------------------------------------------

/**
 * Deletes a source with its chunks, after asking its queued and running jobs to stop (FR-044), then removes its original if it
 * still has one. A storage that cannot remove it does not fail the deletion: the sweep removes it later (FR-055). Returns false
 * when there is no such source.
 */
export async function deleteSource(db: Db, ctx: SourcesContext, input: { sourceId: string; accountId: number }): Promise<boolean> {
  const key = await db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ original_key: string | null }>`SELECT original_key FROM sources WHERE id = ${input.sourceId} FOR UPDATE`.execute(trx);
    const source = rows[0];
    if (source === undefined) return undefined;
    const { rows: active } = await sql<{ id: string }>`SELECT id FROM jobs WHERE source_id = ${input.sourceId} AND state IN ('queued', 'running') ORDER BY id`.execute(trx);
    for (const job of active) await cancelJob(trx, job.id, input.accountId);
    await sql`DELETE FROM sources WHERE id = ${input.sourceId}`.execute(trx);
    return source.original_key;
  });
  if (key === undefined) return false;
  if (key !== null) await removeOriginal(ctx.storage, key);
  return true;
}

/**
 * Deletes a threat model, or a project and every threat model in it, with their sources. The sources reached are locked in id
 * order first, so that a worker's commit and this deletion cannot wait on each other, and their originals are collected; the
 * rows go with the delete (chunks and jobs with them), and the originals are removed once it has committed (FR-054, FR-055).
 * Returns false when there is no such row.
 */
export async function deleteWithSources(db: Db, ctx: SourcesContext, target: { kind: 'threat_model' | 'project'; id: string }): Promise<boolean> {
  const keys: string[] = [];
  const found = await db.transaction().execute(async (trx) => {
    const { rows } =
      target.kind === 'threat_model'
        ? await sql<{ original_key: string | null }>`SELECT original_key FROM sources WHERE threat_model_id = ${target.id} ORDER BY id FOR UPDATE`.execute(trx)
        : await sql<{ original_key: string | null }>`
            SELECT s.original_key FROM sources s JOIN threat_models t ON t.id = s.threat_model_id
            WHERE t.project_id = ${target.id} ORDER BY s.id FOR UPDATE OF s`.execute(trx);
    for (const row of rows) if (row.original_key !== null) keys.push(row.original_key);
    const deleted =
      target.kind === 'threat_model'
        ? await trx.deleteFrom('threat_models').where('id', '=', target.id).returning('id').executeTakeFirst()
        : await trx.deleteFrom('projects').where('id', '=', target.id).returning('id').executeTakeFirst();
    return deleted !== undefined;
  });
  if (found) for (const key of keys) await removeOriginal(ctx.storage, key);
  return found;
}

/** Removes an original and forgets a failure: a file that is left behind is removed by the sweep (FR-055). */
export async function removeOriginal(storage: Storage, key: string): Promise<void> {
  try {
    await storage.delete(key as Parameters<Storage['delete']>[0]);
  } catch {
    // The sweep finds it.
  }
}

// ---- Retrying and refreshing -------------------------------------------------------------------------------------------

/** Locks the source, then the account and the space, queues the job and returns the source as it is then. */
async function queueFor(
  db: Db,
  ctx: SourcesContext,
  input: { sourceId: string; accountId: number },
  decide: (current: SourceRecord, facts: SourceRow) => JobKind,
): Promise<SourceRecord | undefined> {
  try {
    return await db.transaction().execute(async (trx) => {
      const { rows } = await sql`SELECT 1 FROM sources WHERE id = ${input.sourceId} FOR UPDATE`.execute(trx);
      if (rows.length === 0) return undefined;
      await lockAccount(trx, input.accountId);
      await lockSpace(trx);
      const { rows: read } = await sql<SourceRow>`${SOURCE_SELECT} WHERE s.id = ${input.sourceId}`.execute(trx);
      const facts = read[0] as SourceRow;
      const kind = decide(toRecord(facts, ctx), facts);
      // A retry adds nothing to the space, because a source that is not ready counts its upload; a refresh grows it only when
      // the dimension changes, which the commit checks. Both are refused while the space is already over the cap.
      if ((await usedBytes(trx)) > ctx.config.documentSpaceBytes) throw new SourceRefusal(507, MESSAGES.full);
      await enqueueIngestion(trx, { kind: kind as 'ingest_source' | 'refresh_embeddings', sourceId: input.sourceId, threatModelId: facts.threat_model_id, accountId: input.accountId }, ctx.jobs);
      return facts.threat_model_id;
    }).then(async (found) => (found === undefined ? undefined : getSource(db, ctx, input.sourceId)));
  } catch (error) {
    throw translate(error);
  }
}

/**
 * Queues a new job, with the caps that are set now, for a source that failed to ingest, or for a ready source whose last refresh
 * failed (FR-045). Refused, with the reason, when a retry would only fail the same way. Returns undefined when there is no such source.
 */
export function retrySource(db: Db, ctx: SourcesContext, input: { sourceId: string; accountId: number }): Promise<SourceRecord | undefined> {
  return queueFor(db, ctx, input, (current, facts) => {
    if (ctx.embeddingModel === null) throw new SourceRefusal(409, MESSAGES.noProvider);
    if (current.status === 'failed') {
      const problem = retryProblem(hasJob(facts.ing) ? facts.ing : { id: null, state: 'failed', progress: null, failure_category: 'job_error', failure_detail: null, token_cap: null, cost_cap_usd: null, last_model: null }, ctx);
      if (problem !== undefined) throw new SourceRefusal(409, problem);
      return 'ingest_source';
    }
    if (current.status === 'ready' && current.refresh_failure !== null) {
      const problem = retryProblem(facts.ref, ctx);
      if (problem !== undefined) throw new SourceRefusal(409, problem);
      return 'refresh_embeddings';
    }
    throw new SourceRefusal(409, MESSAGES.notFailed);
  });
}

/** Queues a refresh of the embeddings of a ready source whose embeddings are out of date (FR-034). */
export function refreshSource(db: Db, ctx: SourcesContext, input: { sourceId: string; accountId: number }): Promise<SourceRecord | undefined> {
  return queueFor(db, ctx, input, (current) => {
    if (ctx.embeddingModel === null) throw new SourceRefusal(409, MESSAGES.noProvider);
    if (current.status !== 'ready') throw new SourceRefusal(409, MESSAGES.notReady);
    if (current.refresh !== null) throw new SourceRefusal(409, MESSAGES.refreshing);
    if (!current.refreshable) throw new SourceRefusal(409, MESSAGES.current);
    return 'refresh_embeddings';
  });
}
