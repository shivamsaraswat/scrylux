-- Drafts (Phase 3 / Milestone 4, specs/phase-3/milestone-4-system-extraction/data-model.md).
--
-- A draft is the system that a model proposed for one threat model from its sources: elements, assets and assumptions, each with its
-- rationale and its citations. It is kept apart from the threat model: no column of `elements`, `threats` or `mitigations` changes,
-- and nothing here references them, so an AI-proposed item can never be mistaken for an accepted one (FR-050, Principle VI).
--
-- 1. `drafts`: at most one per threat model (FR-052), deleted with it (FR-056).
-- 2. `draft_sources` and `draft_read_chunks`: what the extraction considered and read (FR-004, FR-014). A deleted source takes its rows
--    with it, which is how the draft knows its sources changed (FR-053, research #13).
-- 3. `draft_items`, `draft_asset_holders`, `draft_citations`. A citation keeps the span of its quote inside the chunk and never the
--    quote's text, so a deleted source leaves none of its text here (FR-054, research #4). When its chunk is deleted, its chunk_id
--    becomes NULL and the page says "Source deleted".
-- 4. jobs: the extract_system kind, its three failure categories, and one active extraction per threat model (FR-042).
--
-- There is no vector index. An extraction ranks the chunks of one threat model exactly, in one pass (research #6).

CREATE TABLE drafts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_model_id   UUID NOT NULL,
  -- The extraction that made it. The job keeps its own record if it is ever removed on its own.
  job_id            UUID,
  started_by        INTEGER NOT NULL,
  -- The commit's time: shown, and never compared to decide whether the sources changed (research #13).
  made_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  generation_model  TEXT NOT NULL,
  -- `extract-system/` and twelve hex digits of a hash of the prompt files and the answer's schema (research #12).
  prompt_version    TEXT NOT NULL,
  path              TEXT NOT NULL,
  chunks_read       INTEGER NOT NULL,
  chunks_available  INTEGER NOT NULL,
  -- The sources the extraction considered, read or left out.
  sources_total     INTEGER NOT NULL,
  -- Why the draft has no item (FR-024).
  nothing_found     TEXT,
  CONSTRAINT drafts_generation_model_check CHECK (length(btrim(generation_model)) > 0),
  CONSTRAINT drafts_prompt_version_check CHECK (prompt_version ~ '^extract-system/[0-9a-f]{12}$'),
  CONSTRAINT drafts_path_check CHECK (path IN ('whole', 'retrieval')),
  CONSTRAINT drafts_chunks_read_check CHECK (chunks_read BETWEEN 1 AND 1000),
  -- Reading all of them means reading as many as there are.
  CONSTRAINT drafts_chunks_available_check CHECK (chunks_available >= chunks_read AND (path <> 'whole' OR chunks_available = chunks_read)),
  CONSTRAINT drafts_sources_total_check CHECK (sources_total >= 1),
  CONSTRAINT drafts_nothing_found_check CHECK (nothing_found IS NULL OR (length(btrim(nothing_found)) > 0 AND char_length(nothing_found) <= 300)),
  CONSTRAINT drafts_threat_model_key UNIQUE (threat_model_id),
  CONSTRAINT drafts_threat_model_id_fkey FOREIGN KEY (threat_model_id) REFERENCES threat_models (id) ON DELETE CASCADE,
  CONSTRAINT drafts_job_id_fkey FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL,
  -- RESTRICT: an account that started an extraction cannot be deleted from under its draft, as for projects, sources and jobs.
  CONSTRAINT drafts_started_by_fkey FOREIGN KEY (started_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- What the extraction considered (FR-004): every source of the threat model when it chose its chunks, read or left out because it was
-- not ready. A source that is deleted later takes its row with it.
CREATE TABLE draft_sources (
  draft_id  UUID NOT NULL,
  source_id UUID NOT NULL,
  read      BOOLEAN NOT NULL,
  CONSTRAINT draft_sources_pkey PRIMARY KEY (draft_id, source_id),
  CONSTRAINT draft_sources_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE,
  CONSTRAINT draft_sources_source_id_fkey FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE CASCADE
);
CREATE INDEX draft_sources_source_idx ON draft_sources (source_id);

-- Which chunks were sent, and under which label (FR-014, FR-036).
CREATE TABLE draft_read_chunks (
  draft_id UUID NOT NULL,
  chunk_id UUID NOT NULL,
  label    SMALLINT NOT NULL,
  CONSTRAINT draft_read_chunks_pkey PRIMARY KEY (draft_id, chunk_id),
  CONSTRAINT draft_read_chunks_label_check CHECK (label BETWEEN 1 AND 1000),
  CONSTRAINT draft_read_chunks_label_key UNIQUE (draft_id, label),
  CONSTRAINT draft_read_chunks_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE,
  CONSTRAINT draft_read_chunks_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chunks (id) ON DELETE CASCADE
);
CREATE INDEX draft_read_chunks_chunk_idx ON draft_read_chunks (chunk_id);

-- One proposed element, asset or assumption (FR-021 to FR-023). The model's own `ref` is not stored: items point at each other by id.
CREATE TABLE draft_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id       UUID NOT NULL,
  -- The order of the answer.
  "position"     SMALLINT NOT NULL,
  kind           TEXT NOT NULL,
  -- An element's or an asset's name; NULL exactly for an assumption.
  name           TEXT,
  -- An asset's description or an assumption's statement; NULL for an element.
  body           TEXT,
  rationale      TEXT NOT NULL,
  boundary_id    UUID,
  source_item_id UUID,
  target_item_id UUID,
  -- { "<flag>": true|false }, for elements only; a flag that is absent is "not assessed".
  flags          JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT draft_items_position_check CHECK ("position" BETWEEN 0 AND 69),
  CONSTRAINT draft_items_kind_check CHECK (kind IN ('process', 'data_store', 'external_entity', 'data_flow', 'trust_boundary', 'asset', 'assumption')),
  CONSTRAINT draft_items_name_check CHECK (
    (kind = 'assumption') = (name IS NULL) AND (name IS NULL OR (length(btrim(name)) > 0 AND char_length(name) <= 200))
  ),
  CONSTRAINT draft_items_body_check CHECK (
    (kind IN ('asset', 'assumption')) = (body IS NOT NULL) AND (body IS NULL OR (length(btrim(body)) > 0 AND char_length(body) <= 300))
  ),
  CONSTRAINT draft_items_rationale_check CHECK (length(btrim(rationale)) > 0 AND char_length(rationale) <= 300),
  -- A data flow sits in no boundary, and an asset or an assumption is not in one.
  CONSTRAINT draft_items_boundary_check CHECK (boundary_id IS NULL OR (kind IN ('process', 'data_store', 'external_entity', 'trust_boundary') AND boundary_id <> id)),
  -- A data flow has both endpoints and every other kind has neither, and a flow does not start and end at the same element.
  CONSTRAINT draft_items_endpoints_check CHECK (
    (kind = 'data_flow') = (source_item_id IS NOT NULL) AND (kind = 'data_flow') = (target_item_id IS NOT NULL)
  ),
  CONSTRAINT draft_items_flow_not_self_loop CHECK (source_item_id <> target_item_id),
  CONSTRAINT draft_items_flags_check CHECK (jsonb_typeof(flags) = 'object' AND (flags = '{}'::jsonb OR kind IN ('process', 'data_store', 'external_entity', 'data_flow'))),
  CONSTRAINT draft_items_position_key UNIQUE (draft_id, "position"),
  -- The target of the composite keys below: an item may only point at an item of its own draft.
  CONSTRAINT draft_items_draft_id_id_key UNIQUE (draft_id, id),
  CONSTRAINT draft_items_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts (id) ON DELETE CASCADE,
  -- Deferred, so that a draft is written in the order of the answer whatever points at what.
  CONSTRAINT draft_items_boundary_fkey FOREIGN KEY (draft_id, boundary_id) REFERENCES draft_items (draft_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT draft_items_source_fkey FOREIGN KEY (draft_id, source_item_id) REFERENCES draft_items (draft_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT draft_items_target_fkey FOREIGN KEY (draft_id, target_item_id) REFERENCES draft_items (draft_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- The elements that store or carry an asset (FR-023).
CREATE TABLE draft_asset_holders (
  asset_id   UUID NOT NULL,
  element_id UUID NOT NULL,
  CONSTRAINT draft_asset_holders_pkey PRIMARY KEY (asset_id, element_id),
  CONSTRAINT draft_asset_holders_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES draft_items (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT draft_asset_holders_element_id_fkey FOREIGN KEY (element_id) REFERENCES draft_items (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX draft_asset_holders_element_idx ON draft_asset_holders (element_id);

-- A citation of an item (flag IS NULL) or of one of its flags (flag set). The quote is not stored: it is read from the chunk when the
-- draft is read, from `quote_start` to `quote_end` in code points, as Milestone 3 counts a chunk's offsets (research #4).
CREATE TABLE draft_citations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID NOT NULL,
  flag        TEXT,
  "position"  SMALLINT NOT NULL,
  -- NULL once the chunk's source was deleted: the page says "Source deleted" and never drops the citation silently (FR-054).
  chunk_id    UUID,
  quote_start INTEGER NOT NULL,
  quote_end   INTEGER NOT NULL,
  CONSTRAINT draft_citations_flag_check CHECK (flag IS NULL OR (char_length(flag) BETWEEN 1 AND 64)),
  CONSTRAINT draft_citations_position_check CHECK ("position" BETWEEN 0 AND 4),
  -- A chunk holds at most 2,000 code points and a quote at least 12 (FR-032).
  CONSTRAINT draft_citations_span_check CHECK (quote_start >= 0 AND quote_end > quote_start AND quote_end <= 2000 AND quote_end - quote_start >= 12),
  CONSTRAINT draft_citations_item_id_fkey FOREIGN KEY (item_id) REFERENCES draft_items (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT draft_citations_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chunks (id) ON DELETE SET NULL
);
-- One citation at each position of an item or of a flag. A flag is never empty, so '' stands for "the item itself".
CREATE UNIQUE INDEX draft_citations_position_key ON draft_citations (item_id, coalesce(flag, ''), "position");
CREATE INDEX draft_citations_chunk_idx ON draft_citations (chunk_id) WHERE chunk_id IS NOT NULL;

-- jobs: the extract_system kind, its three failure categories, and at most one active extraction of a threat model (FR-042, FR-044).
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('provider_check', 'ingest_source', 'refresh_embeddings', 'extract_system'));

ALTER TABLE jobs DROP CONSTRAINT jobs_failure_category_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_failure_category_check CHECK (
  failure_category IS NULL OR failure_category IN (
    'not_configured', 'not_authorized', 'not_available', 'rate_limited', 'provider_unavailable',
    'input_too_large', 'output_limit_reached', 'refused', 'rejected', 'invalid_output',
    'cap_reached', 'timed_out', 'worker_lost', 'job_error',
    'unsupported_type', 'encrypted', 'damaged', 'no_text_found', 'too_large', 'too_large_unpacked',
    'unreadable', 'storage_unavailable', 'document_space_full',
    'no_ready_source', 'embeddings_out_of_date', 'sources_changed'
  )
);

-- Two starts that race past the API's check meet this, and the second is refused (research #11).
CREATE UNIQUE INDEX jobs_one_extraction_idx ON jobs (threat_model_id) WHERE kind = 'extract_system' AND state IN ('queued', 'running');
