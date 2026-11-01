// Kysely table types for the five domain tables, the three job tables and the two source tables. Types only: the tables themselves are
// defined by the SQL files in migrations/, and test/schema-types.test.ts checks these against the real columns.
//
// ColumnType<Select, Insert, Update>: `never` marks a column the database owns (set on insert, or
// never written), or one that cannot change once the row exists. users and schema_migrations are
// deliberately absent: they stay on plain parameterized `pg` queries.
import type { ColumnType, Generated } from 'kysely';
import type {
  ElementType,
  Impact,
  JobFailureCategory,
  JobFailureDetail,
  JobKind,
  JobState,
  JsonValue,
  Likelihood,
  Methodology,
  MitigationStatus,
  RiskLevel,
  SourceType,
  StaleReason,
  StrideCategory,
  ThreatModelStatus,
  ThreatOrigin,
  ThreatStatus,
} from '@scrylux/core';

type JsonObject = Record<string, JsonValue>;

// Storage sets both timestamps; updated_at is refreshed by a trigger on every update.
type Timestamp = ColumnType<Date, never, never>;
// A reference fixed at creation: set on insert, never changed.
type Fixed<T> = ColumnType<T, T, never>;

interface ProjectsTable {
  id: Generated<string>;
  name: string;
  description: string;
  created_by: Fixed<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface ThreatModelsTable {
  id: Generated<string>;
  project_id: Fixed<string>;
  name: string;
  methodology: Methodology;
  status: ThreatModelStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface ElementsTable {
  id: Generated<string>;
  threat_model_id: Fixed<string>;
  type: ElementType;
  name: string;
  properties: JsonObject;
  layout: JsonObject | null;
  source_element_id: string | null;
  target_element_id: string | null;
  parent_boundary_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface ThreatsTable {
  id: Generated<string>;
  threat_model_id: Fixed<string>;
  element_id: string | null;
  category: StrideCategory;
  title: string;
  description: string;
  likelihood: Likelihood;
  impact: Impact;
  // A generated column: derived from likelihood and impact, never written.
  risk: ColumnType<RiskLevel, never, never>;
  status: ThreatStatus;
  // Provenance: set once, never changed (Principle VI).
  origin: Fixed<ThreatOrigin>;
  library_ref: string | null;
  // Why a rule-generated threat no longer fits the diagram; NULL when current. Only the rule engine writes it.
  stale: ColumnType<StaleReason | null, StaleReason | null | undefined, StaleReason | null>;
  // Why the threat was accepted or marked not applicable; NULL for any other status, and for decisions made
  // before Phase 2 Milestone 4. The API sets and clears it with the status.
  status_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface MitigationsTable {
  id: Generated<string>;
  threat_id: Fixed<string>;
  description: string;
  status: MitigationStatus;
  external_ref: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// A column the database fills on insert but the caller may set, such as a time a test needs to choose; never updated.
type Settable<T> = ColumnType<T, T | undefined, never>;
// A column a worker or the API changes after the row exists.
type Mutable<T> = ColumnType<T, T | undefined, T>;
// BIGINT and NUMERIC come back from the driver as strings, so reading one gives a string and writing one takes either.
type Exact = ColumnType<string, number | string, never>;
type Counter = ColumnType<string, number | string | undefined, number | string>;

// The queue and the permanent record of every job (Phase 3 Milestone 2, data-model.md). `claim` only goes up: it is the
// fencing number of every worker write. Totals are summed from job_usage when read, never stored.
interface JobsTable {
  id: Generated<string>;
  kind: Fixed<JobKind>;
  input: ColumnType<JsonObject, JsonObject | undefined, never>;
  state: Mutable<JobState>;
  created_by: Fixed<number>;
  queued_at: Settable<Date>;
  next_run_at: Mutable<Date>;
  started_at: Mutable<Date | null>;
  deadline_at: Mutable<Date | null>;
  finished_at: Mutable<Date | null>;
  run: Mutable<number>;
  claim: Counter;
  max_runs: Fixed<number>;
  time_limit_ms: Fixed<number>;
  token_cap: Exact;
  cost_cap_usd: Exact;
  worker_id: Mutable<string | null>;
  lease_expires_at: Mutable<Date | null>;
  cancel_requested_at: Mutable<Date | null>;
  cancelled_by: Mutable<number | null>;
  progress: Mutable<JsonObject | null>;
  failure_category: Mutable<JobFailureCategory | null>;
  failure_detail: Mutable<JobFailureDetail | null>;
  result: Mutable<JsonObject | null>;
  // Set on the two kinds of ingestion, null on a provider check (jobs_scope_check). A job is deleted with its threat model;
  // it keeps its record when its source is deleted, with source_id set to NULL by the foreign key (Phase 3 Milestone 3).
  threat_model_id: Fixed<string | null>;
  source_id: ColumnType<string | null, string | null | undefined, never>;
}

// One row per model request a job made: Milestone 1's usage record. Never updated.
interface JobUsageTable {
  id: ColumnType<string, never, never>;
  job_id: Fixed<string>;
  run: Fixed<number>;
  operation: Fixed<'generate' | 'embed'>;
  provider: Fixed<string>;
  model: Fixed<string>;
  outcome: Fixed<string>;
  attempts: Fixed<number>;
  input_tokens: Fixed<number>;
  output_tokens: Fixed<number>;
  tokens_estimated: Fixed<boolean>;
  // NUMERIC: a string when read. NULL means the price is unknown, never zero.
  cost_usd: ColumnType<string | null, number | string | null, never>;
  cost_estimated: Fixed<boolean>;
  price_source: Fixed<'operator' | 'list' | 'none'>;
  temperature_applied: Fixed<boolean | null>;
  duration_ms: Fixed<number>;
  recorded_at: Timestamp;
}

// One row per running worker process, for "is any worker alive" (FR-008).
interface WorkersTable {
  id: Fixed<string>;
  started_at: Timestamp;
  last_seen_at: Mutable<Date>;
  stopping: Mutable<boolean>;
}

// One design document of a threat model (Phase 3 Milestone 3, data-model.md). Its status is read from its latest ingestion
// job while it is not ready. `original_key` is cleared, with the facts of the ingestion set, in the one commit that makes
// the source ready; only the worker does that (FR-057).
interface SourcesTable {
  id: Generated<string>;
  threat_model_id: Fixed<string>;
  name: Fixed<string>;
  type: Fixed<SourceType>;
  size_bytes: Fixed<number>;
  digest: Fixed<Buffer>;
  added_by: Fixed<number>;
  added_at: Timestamp;
  original_key: Mutable<string | null>;
  // BIGINT: a string when read, and either when written.
  stored_bytes: ColumnType<string, number | string, number | string>;
  ready_at: Mutable<Date | null>;
  text_chars: Mutable<number | null>;
  chunk_count: Mutable<number | null>;
  pages_without_text: Mutable<number | null>;
  embedding_model: Mutable<string | null>;
  embedding_dimension: Mutable<number | null>;
}

// One consecutive slice of a source's text. Everything but the embedding is fixed once the chunk is written: its id and
// text are cited by later milestones (FR-023). The embedding is a pgvector `vector` of any dimension, read and written in
// pgvector's text form, '[1,2,3]', always as a bound parameter; a refresh replaces it.
interface ChunksTable {
  id: Generated<string>;
  source_id: Fixed<string>;
  position: Fixed<number>;
  start_offset: Fixed<number>;
  end_offset: Fixed<number>;
  text: Fixed<string>;
  page_first: Fixed<number | null>;
  page_last: Fixed<number | null>;
  line_first: Fixed<number | null>;
  line_last: Fixed<number | null>;
  heading: Fixed<string | null>;
  embedding: ColumnType<string, string, string>;
}

export interface Database {
  projects: ProjectsTable;
  threat_models: ThreatModelsTable;
  elements: ElementsTable;
  threats: ThreatsTable;
  mitigations: MitigationsTable;
  jobs: JobsTable;
  job_usage: JobUsageTable;
  workers: WorkersTable;
  sources: SourcesTable;
  chunks: ChunksTable;
}
