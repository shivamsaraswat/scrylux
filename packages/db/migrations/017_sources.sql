-- Sources and chunks (Phase 3 / Milestone 3, specs/phase-3/milestone-3-ingestion/data-model.md).
--
-- A source is a design document added to a threat model; its chunks are the consecutive slices of its text that later
-- milestones cite, each with its embedding. This migration also turns the database into one that has the pgvector
-- extension and changes `jobs` for the two job kinds of ingestion.
--
-- 1. The extension. A database without it, or a database user who may not enable it, stops here with a message an
--    operator can act on (SQLSTATE class SX, raised by nothing but Scrylux's own migrations, so the migration runner may
--    print its text), and the whole migration rolls back (FR-091, research #16).
-- 2. The reindex. pgvector's only image is Debian-based and sorts text by glibc's rules, where the Alpine image Scrylux
--    shipped before sorts by musl's. A data volume moved from one to the other keeps B-tree indexes in the old order,
--    and they silently return wrong answers. Rebuilding every index of every table that exists before this migration
--    puts them in the new order. It cannot run earlier, because it needs the extension, which the old image lacks, so
--    every install that applies this migration has already moved. For one that did not change its C library, it is a
--    harmless few seconds (research #15).
-- 3. sources and chunks.
-- 4. jobs: the threat model and the source a job belongs to, the two kinds, and the categories of ingestion.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION 'This database does not have the pgvector extension, which Scrylux needs from v0.2. See docs/install.md#upgrading-to-v02'
      USING ERRCODE = 'SX001';
  END IF;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE EXCEPTION 'This database has the pgvector extension, but the database user Scrylux connects as may not enable it. Run CREATE EXTENSION vector; in this database as an administrator, then start Scrylux again. See docs/install.md#upgrading-to-v02'
      USING ERRCODE = 'SX002';
  END;
END $$;

-- Every table that exists after migration 016, schema_migrations first. A constant list: no name comes from a query.
REINDEX TABLE schema_migrations;
REINDEX TABLE users;
REINDEX TABLE projects;
REINDEX TABLE threat_models;
REINDEX TABLE elements;
REINDEX TABLE threats;
REINDEX TABLE mitigations;
REINDEX TABLE browser_sessions;
REINDEX TABLE sign_in_throttle;
REINDEX TABLE jobs;
REINDEX TABLE job_usage;
REINDEX TABLE workers;

-- One design document of a threat model. Its status is not stored: it is read from the source's latest ingestion job
-- while the source is not ready (research #1). What is stored is what a successful ingestion wrote.
CREATE TABLE sources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_model_id     UUID NOT NULL,
  -- A display name only (FR-008): never a path or a storage key.
  name                TEXT NOT NULL,
  type                TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  -- SHA-256 of the bytes received: the same content is not added twice to one threat model (FR-006).
  digest              BYTEA NOT NULL,
  added_by            INTEGER NOT NULL,
  added_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The stored original, while the source needs it. NULL from the commit that makes the source ready (FR-057).
  original_key        TEXT,
  -- What the source counts toward the install's document space (FR-009): its upload size until it is ready, then its
  -- text and embeddings.
  stored_bytes        BIGINT NOT NULL,
  ready_at            TIMESTAMPTZ,
  text_chars          INTEGER,
  chunk_count         INTEGER,
  pages_without_text  INTEGER,
  embedding_model     TEXT,
  embedding_dimension SMALLINT,
  CONSTRAINT sources_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT sources_type_check CHECK (type IN ('md', 'txt', 'pdf', 'docx', 'text')),
  CONSTRAINT sources_size_check CHECK (size_bytes > 0),
  CONSTRAINT sources_digest_check CHECK (octet_length(digest) = 32),
  CONSTRAINT sources_stored_bytes_check CHECK (stored_bytes > 0),
  CONSTRAINT sources_original_key_check CHECK (
    original_key IS NULL OR original_key ~ '^sources/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  -- A source is ready exactly when the facts of its ingestion are there.
  CONSTRAINT sources_ready_check CHECK (
    (ready_at IS NULL AND text_chars IS NULL AND chunk_count IS NULL AND embedding_model IS NULL AND embedding_dimension IS NULL)
    OR (ready_at IS NOT NULL AND text_chars IS NOT NULL AND chunk_count IS NOT NULL AND embedding_model IS NOT NULL AND embedding_dimension IS NOT NULL)
  ),
  -- A source that is not ready has its original, and a ready one does not (FR-057).
  CONSTRAINT sources_original_presence_check CHECK ((ready_at IS NULL) = (original_key IS NOT NULL)),
  CONSTRAINT sources_pages_without_text_check CHECK (
    pages_without_text IS NULL OR (type = 'pdf' AND ready_at IS NOT NULL AND pages_without_text >= 0)
  ),
  CONSTRAINT sources_text_chars_check CHECK (text_chars IS NULL OR text_chars >= 1),
  CONSTRAINT sources_chunk_count_check CHECK (chunk_count IS NULL OR chunk_count >= 1),
  CONSTRAINT sources_dimension_check CHECK (embedding_dimension IS NULL OR embedding_dimension BETWEEN 1 AND 16000),
  CONSTRAINT sources_embedding_model_check CHECK (embedding_model IS NULL OR length(btrim(embedding_model)) > 0),
  CONSTRAINT sources_digest_key UNIQUE (threat_model_id, digest),
  CONSTRAINT sources_original_key_key UNIQUE (original_key),
  -- A threat model takes its sources with it (FR-054).
  CONSTRAINT sources_threat_model_id_fkey FOREIGN KEY (threat_model_id) REFERENCES threat_models (id) ON DELETE CASCADE,
  -- RESTRICT: an account that added a source cannot be deleted from under it, as for projects and jobs.
  CONSTRAINT sources_added_by_fkey FOREIGN KEY (added_by) REFERENCES users (id) ON DELETE RESTRICT
);

-- The list of a threat model's sources, oldest first, and their count.
CREATE INDEX sources_list_idx ON sources (threat_model_id, added_at, id);

-- One consecutive slice of a source's extracted text. Its id and text never change once its source is ready, because later
-- milestones cite chunks by id (FR-023). The offsets count code points, as Postgres's char_length does, so that reading
-- the chunks in order gives the text back exactly (FR-021, research #6, #7).
CREATE TABLE chunks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id    UUID NOT NULL,
  "position"   INTEGER NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset   INTEGER NOT NULL,
  text         TEXT NOT NULL,
  page_first   INTEGER,
  page_last    INTEGER,
  line_first   INTEGER,
  line_last    INTEGER,
  heading      TEXT,
  -- No fixed dimension: a model's vectors fit whatever size it makes (FR-032). A source holds the vectors of one model,
  -- named on the source row. There is no vector index yet: the first milestone that searches adds the one it needs.
  embedding    vector NOT NULL,
  CONSTRAINT chunks_position_check CHECK ("position" >= 0),
  CONSTRAINT chunks_offsets_check CHECK (start_offset >= 0 AND end_offset > start_offset AND end_offset - start_offset <= 2000),
  CONSTRAINT chunks_text_check CHECK (char_length(text) = end_offset - start_offset),
  CONSTRAINT chunks_pages_check CHECK (
    (page_first IS NULL AND page_last IS NULL) OR (page_first IS NOT NULL AND page_last IS NOT NULL AND page_first >= 1 AND page_last >= page_first)
  ),
  CONSTRAINT chunks_lines_check CHECK (
    (line_first IS NULL AND line_last IS NULL) OR (line_first IS NOT NULL AND line_last IS NOT NULL AND line_first >= 1 AND line_last >= line_first)
  ),
  CONSTRAINT chunks_heading_check CHECK (heading IS NULL OR char_length(heading) <= 200),
  CONSTRAINT chunks_position_key UNIQUE (source_id, "position"),
  CONSTRAINT chunks_source_id_fkey FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE CASCADE
);

-- jobs: an ingestion job belongs to a threat model, and is deleted with it (FR-054). It points at its source, and keeps
-- its record when the source is deleted (ON DELETE SET NULL), because a job's usage is the install's spend history.
ALTER TABLE jobs
  ADD COLUMN threat_model_id UUID,
  ADD COLUMN source_id UUID;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_threat_model_id_fkey FOREIGN KEY (threat_model_id) REFERENCES threat_models (id) ON DELETE CASCADE,
  ADD CONSTRAINT jobs_source_id_fkey FOREIGN KEY (source_id) REFERENCES sources (id) ON DELETE SET NULL;

ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('provider_check', 'ingest_source', 'refresh_embeddings'));

-- The provider check belongs to no threat model, and every other kind does.
ALTER TABLE jobs ADD CONSTRAINT jobs_scope_check CHECK ((kind = 'provider_check') = (threat_model_id IS NULL));

ALTER TABLE jobs DROP CONSTRAINT jobs_failure_category_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_failure_category_check CHECK (
  failure_category IS NULL OR failure_category IN (
    'not_configured', 'not_authorized', 'not_available', 'rate_limited', 'provider_unavailable',
    'input_too_large', 'output_limit_reached', 'refused', 'rejected', 'invalid_output',
    'cap_reached', 'timed_out', 'worker_lost', 'job_error',
    'unsupported_type', 'encrypted', 'damaged', 'no_text_found', 'too_large', 'too_large_unpacked',
    'unreadable', 'storage_unavailable', 'document_space_full'
  )
);

-- A detail chooses the message of a category that names a bound (FR-011, FR-044): which cap, which limit.
ALTER TABLE jobs DROP CONSTRAINT jobs_failure_detail_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_failure_detail_check CHECK (
  failure_detail IS NULL
  OR (failure_detail = 'cap_below_one_request' AND failure_category = 'cap_reached')
  OR (failure_detail IN ('time', 'memory') AND failure_category = 'unreadable')
  OR (failure_detail IN ('pages', 'chars') AND failure_category = 'too_large')
);

-- A job that has ended never changes again (FR-012), with one exception: its link to a source that was deleted. Deleting a
-- source sets that link to NULL on every job of it, ended or not, and nothing else about the job changes.
CREATE OR REPLACE FUNCTION jobs_final_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    IF OLD.source_id IS NOT NULL AND NEW.source_id IS NULL AND (to_jsonb(NEW) - 'source_id') = (to_jsonb(OLD) - 'source_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a job that has ended cannot change'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'jobs_final_is_final';
  END IF;
  RETURN NEW;
END $$;

-- The latest job of each source, which gives the source its status.
CREATE INDEX jobs_source_idx ON jobs (source_id, kind, queued_at DESC) WHERE source_id IS NOT NULL;
-- Deleting a threat model finds its jobs by this.
CREATE INDEX jobs_threat_model_idx ON jobs (threat_model_id) WHERE threat_model_id IS NOT NULL;
