// Kysely table types for the five domain tables. Types only: the tables themselves are defined by
// the SQL files in migrations/, and test/schema-types.test.ts checks these against the real columns.
//
// ColumnType<Select, Insert, Update>: `never` marks a column the database owns (set on insert, or
// never written), or one that cannot change once the row exists. users and schema_migrations are
// deliberately absent: they stay on plain parameterized `pg` queries.
import type { ColumnType, Generated } from 'kysely';
import type {
  ElementType,
  Impact,
  JsonValue,
  Likelihood,
  Methodology,
  MitigationStatus,
  RiskLevel,
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

export interface Database {
  projects: ProjectsTable;
  threat_models: ThreatModelsTable;
  elements: ElementsTable;
  threats: ThreatsTable;
  mitigations: MitigationsTable;
}
