import { z } from 'zod';
import { requiredText, timestamp, uuid } from '../fields.js';
import { IngestionStep, JobFailureCategory, JobUser } from './job.js';

// The records of the source routes (Phase 3 Milestone 3, specs/phase-3/milestone-3-ingestion/data-model.md and
// contracts/http-api.md). The API parses every success body with them, so a stray column is a server bug and not a leak, and
// the web app parses what it receives. Nothing here can hold a stored original's key, a path, a bucket or an embedding.
// Every object is strict. Lengths and offsets count code points, as Postgres's char_length does.

const count = z.number().int().min(0);
const positive = z.number().int().min(1);

export const SOURCE_TYPES = ['md', 'txt', 'pdf', 'docx', 'text'] as const;
export const SourceType = z.enum(SOURCE_TYPES);
export type SourceType = z.infer<typeof SourceType>;

/** Derived from the source's latest ingestion job while it is not ready (research #1). */
export const SOURCE_STATUSES = ['waiting', 'processing', 'ready', 'failed'] as const;
export const SourceStatus = z.enum(SOURCE_STATUSES);
export type SourceStatus = z.infer<typeof SourceStatus>;

/** The most a chunk holds (FR-020), and the longest heading and file name it records (FR-022, FR-002). */
export const CHUNK_MAX_CHARS = 2000;
export const HEADING_MAX_CHARS = 200;
export const SOURCE_NAME_MAX_CHARS = 255;
export const SOURCE_TITLE_MAX_CHARS = 200;
export const EMBEDDING_MAX_DIMENSION = 16_000;

const codePoints = (value: string): number => [...value].length;

/** One fixed message for every problem with a file name, which never repeats the name (Principle I). */
const FILE_NAME_MESSAGE = `The file name must be 1 to ${SOURCE_NAME_MAX_CHARS} characters, hold no control character, and end in .md, .txt, .pdf or .docx.`;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SUPPORTED_EXTENSION = /\.(?:md|txt|pdf|docx)$/i;

/** An upload's file name, checked at the boundary: it becomes a display name and nothing else (FR-008). */
export const SourceFileName = z
  .string()
  .trim()
  .refine((name) => name.length > 0 && codePoints(name) <= SOURCE_NAME_MAX_CHARS && !CONTROL.test(name) && SUPPORTED_EXTENSION.test(name), { message: FILE_NAME_MESSAGE })
  .meta({ maxLength: SOURCE_NAME_MAX_CHARS });
export type SourceFileName = z.infer<typeof SourceFileName>;

/** Pasted text is a source like an uploaded `.txt` file, named by its title (FR-002). */
export const SourceTextInput = z.strictObject({
  title: requiredText(SOURCE_TITLE_MAX_CHARS),
  text: z.string().refine((text) => /\S/.test(text), { message: 'must hold at least one character that is not a space' }),
});
export type SourceTextInput = z.infer<typeof SourceTextInput>;

export const SourceProgress = z.strictObject({ step: IngestionStep, done: count.optional(), total: count.optional() });
export type SourceProgress = z.infer<typeof SourceProgress>;

/** A source whose ingestion was cancelled shows the category `cancelled`, which is not a job category (FR-044). */
export const SourceFailureCategory = z.union([JobFailureCategory, z.literal('cancelled')]);
export type SourceFailureCategory = z.infer<typeof SourceFailureCategory>;

export const SourceFailure = z.strictObject({
  category: SourceFailureCategory,
  message: z.string(),
  hint: z.string(),
  /** Whether a retry is offered, and accepted by the API (FR-045): a retry never spends again on a certain failure. */
  retryable: z.boolean(),
});
export type SourceFailure = z.infer<typeof SourceFailure>;

/** Whether the vectors of a ready source are from the embedding model that is configured now (FR-033). */
export const EMBEDDING_STATES = ['current', 'out_of_date', 'no_provider'] as const;
export const EmbeddingState = z.enum(EMBEDDING_STATES);
export type EmbeddingState = z.infer<typeof EmbeddingState>;

export const SourceReady = z.strictObject({
  at: timestamp,
  text_chars: positive,
  chunk_count: positive,
  /** PDFs only: how many pages held no text, so a person knows what was missed (FR-014). */
  pages_without_text: count.nullable(),
  embedding: z.strictObject({
    model: z.string().min(1),
    dimension: z.number().int().min(1).max(EMBEDDING_MAX_DIMENSION),
    state: EmbeddingState,
  }),
});
export type SourceReady = z.infer<typeof SourceReady>;

export const SourceRefresh = z.strictObject({ state: z.enum(['queued', 'running']), progress: SourceProgress.nullable() });
export type SourceRefresh = z.infer<typeof SourceRefresh>;

export const SourceRecord = z
  .strictObject({
    id: uuid,
    threat_model_id: uuid,
    name: z.string(),
    type: SourceType,
    size_bytes: positive,
    added_by: JobUser,
    added_at: timestamp,
    status: SourceStatus,
    /** While the source is processing. */
    progress: SourceProgress.nullable(),
    /** When the source has failed. */
    failure: SourceFailure.nullable(),
    /** When the source is ready. */
    ready: SourceReady.nullable(),
    /** A refresh of the embeddings of a ready source, while it is queued or running. */
    refresh: SourceRefresh.nullable(),
    /** The last refresh of a ready source, if it failed (FR-034). */
    refresh_failure: SourceFailure.nullable(),
    /** A ready source whose embeddings are out of date and can be refreshed now. */
    refreshable: z.boolean(),
  })
  .superRefine((source, ctx) => {
    const problem = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if ((source.status === 'ready') !== (source.ready !== null)) problem('ready', 'is set exactly when the status is ready');
    if ((source.status === 'failed') !== (source.failure !== null)) problem('failure', 'is set exactly when the status is failed');
    if (source.progress !== null && source.status !== 'processing') problem('progress', 'is set only while the source is processing');
    if (source.status !== 'ready') {
      if (source.refresh !== null) problem('refresh', 'is set only on a ready source');
      if (source.refresh_failure !== null) problem('refresh_failure', 'is set only on a ready source');
      if (source.refreshable) problem('refreshable', 'is true only on a ready source');
    }
  });
export type SourceRecord = z.infer<typeof SourceRecord>;

export const SourceList = z.strictObject({
  sources: SourceRecord.array(),
  /** What the add form shows (FR-004, FR-005, FR-009). */
  limits: z.strictObject({
    max_bytes: positive,
    per_threat_model: positive,
    used_bytes: count,
    document_space_bytes: positive,
  }),
});
export type SourceList = z.infer<typeof SourceList>;

const range = z.strictObject({ first: positive, last: positive }).refine((r) => r.last >= r.first, { message: 'last must not be before first' });

/** One chunk of a ready source. Its id and text never change (FR-023). The embedding is not sent. */
export const ChunkRecord = z
  .strictObject({
    id: uuid,
    position: count,
    start_offset: count,
    end_offset: positive,
    text: z.string(),
    pages: range.nullable(),
    lines: range.nullable(),
    heading: z.string().max(HEADING_MAX_CHARS).nullable(),
  })
  .refine((chunk) => chunk.end_offset > chunk.start_offset && chunk.end_offset - chunk.start_offset <= CHUNK_MAX_CHARS, {
    message: `a chunk holds 1 to ${CHUNK_MAX_CHARS} characters`,
  });
export type ChunkRecord = z.infer<typeof ChunkRecord>;

export const ChunkPage = z.strictObject({ chunks: ChunkRecord.array(), has_more: z.boolean() });
export type ChunkPage = z.infer<typeof ChunkPage>;

// One fixed message for every problem with the query, which never repeats what the client sent, as JobListQuery.
const CHUNK_QUERY_MESSAGE = 'limit must be a whole number from 1 to 100, and offset a whole number of 0 or more';

export const ChunkPageQuery = z.strictObject(
  {
    limit: z.coerce.number({ error: CHUNK_QUERY_MESSAGE }).int({ error: CHUNK_QUERY_MESSAGE }).min(1, { error: CHUNK_QUERY_MESSAGE }).max(100, { error: CHUNK_QUERY_MESSAGE }).default(50),
    offset: z.coerce.number({ error: CHUNK_QUERY_MESSAGE }).int({ error: CHUNK_QUERY_MESSAGE }).min(0, { error: CHUNK_QUERY_MESSAGE }).default(0),
  },
  { error: CHUNK_QUERY_MESSAGE },
);
export type ChunkPageQuery = z.infer<typeof ChunkPageQuery>;
