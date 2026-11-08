import { z } from 'zod';
import { ELEMENT_FLAGS } from '../element-properties.js';
import { ELEMENT_TYPES } from '../enums.js';
import { requiredText, timestamp, uuid } from '../fields.js';
import { JobRecord, JobUser } from './job.js';

// The system a model proposes from a threat model's documents (Phase 3 Milestone 4, specs/phase-3/milestone-4-system-extraction/
// data-model.md). Two things live here: `DraftAnswer`, the structure the model is asked to answer in, and the records the draft
// routes send. Nothing here is part of the threat model: a draft is kept apart from it (FR-050), and every item carries its
// rationale and citations (Principle VI).

/** The limits of a draft (research #9): a full draft fits the output limit, and a threat model's 1,000 elements hold it (FR-034). */
export const DRAFT_LIMITS = {
  elements: 40,
  assets: 15,
  assumptions: 15,
  citationsPerItem: 5,
  citationsPerFlag: 2,
  flagsPerElement: 4,
  holdersPerAsset: 10,
  nameMax: 200,
  textMax: 300,
  quoteMin: 12,
  quoteMax: 200,
} as const;

const codePoints = (value: string): number => [...value].length;

// Not trimmed: a quote is matched against a chunk with runs of whitespace treated as one, and that is the check's to do (FR-032).
// Counted in code points to match Postgres char_length, and stated as metadata for the JSON Schema a provider is sent, which a
// refinement never reaches.
function quoteText(min: number, max: number) {
  return z
    .string()
    .refine((value) => codePoints(value) >= min, { message: `must be at least ${min} characters` })
    .refine((value) => codePoints(value) <= max, { message: `must be at most ${max} characters` })
    .meta({ minLength: min, maxLength: max });
}

/** What the model cites a chunk by: `c1`, `c2`… in the order the chunks were sent. Never an identifier (FR-036, research #3). */
export const CHUNK_LABEL_PATTERN = /^c[1-9][0-9]{0,3}$/;
/** What the model calls an item of its answer, so that items can name each other. Not stored (research #3). */
export const ITEM_REF_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

const label = z.string().regex(CHUNK_LABEL_PATTERN);
const ref = z.string().regex(ITEM_REF_PATTERN);

/** Every flag name any element type allows. Whether it applies to a given type is the request's check (FR-033). */
export const DRAFT_FLAG_NAMES = [...new Set(Object.values(ELEMENT_FLAGS).flat())] as [string, ...string[]];

const citation = z.strictObject({ chunk: label, quote: quoteText(DRAFT_LIMITS.quoteMin, DRAFT_LIMITS.quoteMax) });
const itemCitations = citation.array().min(1).max(DRAFT_LIMITS.citationsPerItem);
const rationale = requiredText(DRAFT_LIMITS.textMax);

const answerFlag = z.strictObject({
  flag: z.enum(DRAFT_FLAG_NAMES),
  value: z.boolean(),
  citations: citation.array().min(1).max(DRAFT_LIMITS.citationsPerFlag),
});

const answerElement = z.strictObject({
  ref,
  type: z.enum(ELEMENT_TYPES),
  name: requiredText(DRAFT_LIMITS.nameMax),
  boundary: ref.nullable(),
  source: ref.nullable(),
  target: ref.nullable(),
  flags: answerFlag.array().max(DRAFT_LIMITS.flagsPerElement),
  rationale,
  citations: itemCitations,
});

const answerAsset = z.strictObject({
  ref,
  name: requiredText(DRAFT_LIMITS.nameMax),
  description: requiredText(DRAFT_LIMITS.textMax),
  held_by: ref.array().max(DRAFT_LIMITS.holdersPerAsset),
  rationale,
  citations: itemCitations,
});

const answerAssumption = z.strictObject({
  ref,
  statement: requiredText(DRAFT_LIMITS.textMax),
  rationale,
  citations: itemCitations,
});

/**
 * The model's answer. Every object is strict and every field is required, with `null` where one may be absent, as structured
 * output needs. The JSON Schema it gives is the same for every request. What depends on the request (which labels were sent, what
 * a chunk says, which reference names which item) is a refinement the worker adds (`checksFor`, research #2), which never
 * reaches the schema a provider is sent.
 */
export const DraftAnswer = z.strictObject({
  elements: answerElement.array().max(DRAFT_LIMITS.elements),
  assets: answerAsset.array().max(DRAFT_LIMITS.assets),
  assumptions: answerAssumption.array().max(DRAFT_LIMITS.assumptions),
  /** Why there is no item, set exactly when there is none (FR-024). */
  nothing_found: requiredText(DRAFT_LIMITS.textMax).nullable(),
});
export type DraftAnswer = z.infer<typeof DraftAnswer>;
export type DraftAnswerElement = z.infer<typeof answerElement>;
export type DraftAnswerAsset = z.infer<typeof answerAsset>;
export type DraftAnswerAssumption = z.infer<typeof answerAssumption>;
export type DraftAnswerCitation = z.infer<typeof citation>;

// ---- The records of the draft routes ------------------------------------------------------------------------------------

const count = z.number().int().min(0);

export const DRAFT_PATHS = ['whole', 'retrieval'] as const;
export const DraftPath = z.enum(DRAFT_PATHS);
export type DraftPath = z.infer<typeof DraftPath>;

/** Where a cited chunk is: enough to name it and to open the source at it (FR-062). */
export const CitedChunk = z.strictObject({
  id: uuid,
  source_id: uuid,
  source_name: z.string(),
  position: count,
  page_first: z.number().int().nullable(),
  page_last: z.number().int().nullable(),
  line_first: z.number().int().nullable(),
  line_last: z.number().int().nullable(),
  heading: z.string().nullable(),
});
export type CitedChunk = z.infer<typeof CitedChunk>;

/**
 * A citation as the page shows it. The quote is read from the chunk when the draft is read, never stored, so a deleted source
 * leaves none of its text here: both are null then, and the page says "Source deleted" (FR-054, research #4).
 */
export const CitationRecord = z
  .strictObject({ chunk: CitedChunk.nullable(), quote: z.string().nullable() })
  .refine((value) => (value.chunk === null) === (value.quote === null), { message: 'a citation has both its chunk and its quote, or neither' });
export type CitationRecord = z.infer<typeof CitationRecord>;

const FlagRecord = z.strictObject({ flag: z.string(), value: z.boolean(), citations: CitationRecord.array() });

export const DraftElementRecord = z.strictObject({
  id: uuid,
  type: z.enum(ELEMENT_TYPES),
  name: z.string(),
  boundary_id: uuid.nullable(),
  source_id: uuid.nullable(),
  target_id: uuid.nullable(),
  flags: FlagRecord.array(),
  rationale: z.string(),
  /** May be empty once the sources it cited are deleted: the page says so (FR-054). */
  citations: CitationRecord.array(),
});
export type DraftElementRecord = z.infer<typeof DraftElementRecord>;

export const DraftAssetRecord = z.strictObject({
  id: uuid,
  name: z.string(),
  description: z.string(),
  held_by: uuid.array(),
  rationale: z.string(),
  citations: CitationRecord.array(),
});
export type DraftAssetRecord = z.infer<typeof DraftAssetRecord>;

export const DraftAssumptionRecord = z.strictObject({
  id: uuid,
  statement: z.string(),
  rationale: z.string(),
  citations: CitationRecord.array(),
});
export type DraftAssumptionRecord = z.infer<typeof DraftAssumptionRecord>;

export const DraftSourceRecord = z.strictObject({ id: uuid, name: z.string(), read: z.boolean() });
export type DraftSourceRecord = z.infer<typeof DraftSourceRecord>;

export const DraftRecord = z.strictObject({
  id: uuid,
  threat_model_id: uuid,
  made_at: timestamp,
  started_by: JobUser,
  job_id: uuid.nullable(),
  generation_model: z.string(),
  /** `extract-system/` and the first 12 hex digits of a hash of the prompt files and the answer's schema (research #12). */
  prompt_version: z.string().regex(/^extract-system\/[0-9a-f]{12}$/),
  path: DraftPath,
  chunks_read: count,
  chunks_available: count,
  /** The sources the extraction considered that still exist, read or left out (FR-004). */
  sources: DraftSourceRecord.array(),
  /** How many sources it considered that have since been deleted (FR-054). */
  sources_deleted: count,
  /** A source was added or deleted, or a left-out source became ready, since the draft was made (FR-053, research #13). */
  sources_changed: z.boolean(),
  nothing_found: z.string().nullable(),
  elements: DraftElementRecord.array(),
  assets: DraftAssetRecord.array(),
  assumptions: DraftAssumptionRecord.array(),
  /** Which chunks were sent, so a person can see what was read (FR-014). */
  read_chunks: z.strictObject({ source_id: uuid, position: count }).array(),
});
export type DraftRecord = z.infer<typeof DraftRecord>;

/** Why a start is not offered: the reasons of the start route's refusals, in their order (contracts/http-api.md). */
export const START_REFUSALS = [
  'no_generation_provider',
  'extraction_active',
  'sources_processing',
  'no_ready_source',
  'no_embedding_provider',
  'embeddings_out_of_date',
  'would_repeat',
] as const;
export const StartRefusal = z.enum(START_REFUSALS);
export type StartRefusal = z.infer<typeof StartRefusal>;

/** The extraction panel of a threat model: its latest job, whether a start would be accepted, and what the page shows (FR-063). */
export const ExtractionStatus = z.strictObject({
  latest: JobRecord.nullable(),
  start: z.discriminatedUnion('offered', [
    z.strictObject({ offered: z.literal(true), path: DraftPath, replaces_draft: z.boolean() }),
    z.strictObject({
      offered: z.literal(false),
      reason: StartRefusal,
      /** The fixed text of the refusal. It names no source: the page names them from `source_ids` (FR-004). */
      message: z.string(),
      source_ids: uuid.array(),
    }),
  ]),
  chunks_available: count,
  budget_chars: z.number().int().min(1),
});
export type ExtractionStatus = z.infer<typeof ExtractionStatus>;
