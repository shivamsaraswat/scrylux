-- Reviewing a draft (Phase 3 / Milestone 5, specs/phase-3/milestone-5-review-ui/data-model.md).
--
-- 1. `assets`, `asset_holders` and `assumptions`: two new kinds of threat-model record, which an accept can create and a person can create,
--    edit and delete (FR-006, FR-021). A name or a statement is unique within a threat model ignoring case and surrounding whitespace, the
--    same expression the review's comparison matches on (research #3). A threat model holds at most 200 of each (research #6).
-- 2. `provenance` and `provenance_citations`: where a record, or one flag of an element, came from, copied from the draft item that an
--    accept turned into it. It outlives the draft, goes with its record, and holds the span of each quote and never its text, so a
--    deleted source leaves none of its text here (FR-017, research #8).
-- 3. `draft_items`: the decision on an item (FR-001, FR-014, FR-018). Milestone 4 kept a draft wholly apart from the threat model. It no
--    longer does: an item points at the record an accept created, so that a deleted record makes the item undecided again. Nothing in
--    `elements`, `assets` or `assumptions` points at a draft (research #1).

CREATE TABLE assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_model_id UUID NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assets_name_check CHECK (length(btrim(name)) > 0 AND char_length(name) <= 200),
  CONSTRAINT assets_description_check CHECK (length(btrim(description)) > 0 AND char_length(description) <= 10000),
  -- The target of the composite keys below: a holder or a provenance row can only refer to an asset of its own threat model.
  CONSTRAINT assets_model_id_key UNIQUE (threat_model_id, id),
  CONSTRAINT assets_threat_model_id_fkey FOREIGN KEY (threat_model_id) REFERENCES threat_models (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX assets_name_key ON assets (threat_model_id, lower(btrim(name)));

CREATE TRIGGER assets_set_timestamps BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_timestamps();

-- A threat model holds at most 200 assets. The number is also MAX_ASSETS in packages/core; a test keeps the two equal. The model's row is
-- locked first, as 013 does for elements, so that two inserts cannot both count 199 (a lock that does not conflict with the KEY SHARE locks
-- of ordinary foreign-key checks).
CREATE FUNCTION assets_limit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  max_assets CONSTANT integer := 200;
BEGIN
  PERFORM 1 FROM threat_models WHERE id = NEW.threat_model_id FOR NO KEY UPDATE;
  IF (SELECT count(*) FROM assets WHERE threat_model_id = NEW.threat_model_id) >= max_assets THEN
    RAISE EXCEPTION 'a threat model can hold at most % assets', max_assets
      USING ERRCODE = 'check_violation', CONSTRAINT = 'assets_limit';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assets_limit BEFORE INSERT ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_limit_check();

-- The elements that store or carry an asset. Both keys carry the threat model's id, so a holder is an element of the same model, and
-- deleting either side removes the row and leaves the other (FR-021).
CREATE TABLE asset_holders (
  threat_model_id UUID NOT NULL,
  asset_id        UUID NOT NULL,
  element_id      UUID NOT NULL,
  CONSTRAINT asset_holders_pkey PRIMARY KEY (asset_id, element_id),
  CONSTRAINT asset_holders_asset_fkey FOREIGN KEY (threat_model_id, asset_id) REFERENCES assets (threat_model_id, id) ON DELETE CASCADE,
  CONSTRAINT asset_holders_element_fkey FOREIGN KEY (threat_model_id, element_id) REFERENCES elements (threat_model_id, id) ON DELETE CASCADE
);
CREATE INDEX asset_holders_element_idx ON asset_holders (element_id);

-- A holder is a node: an external entity, a process or a data store, never a data flow or a trust boundary. An element's type can only change
-- within its class (006), so a node stays a node and this check cannot be raced.
CREATE FUNCTION asset_holders_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM elements e WHERE e.id = NEW.element_id AND element_class(e.type) <> 'node') THEN
    RAISE EXCEPTION 'an asset can only be held by an external entity, a process or a data store'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'asset_holders_node';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER asset_holders_check BEFORE INSERT ON asset_holders
  FOR EACH ROW EXECUTE FUNCTION asset_holders_check();

CREATE TABLE assumptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_model_id UUID NOT NULL,
  statement       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assumptions_statement_check CHECK (length(btrim(statement)) > 0 AND char_length(statement) <= 10000),
  CONSTRAINT assumptions_model_id_key UNIQUE (threat_model_id, id),
  CONSTRAINT assumptions_threat_model_id_fkey FOREIGN KEY (threat_model_id) REFERENCES threat_models (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX assumptions_statement_key ON assumptions (threat_model_id, lower(btrim(statement)));

CREATE TRIGGER assumptions_set_timestamps BEFORE UPDATE ON assumptions
  FOR EACH ROW EXECUTE FUNCTION set_timestamps();

-- A threat model holds at most 200 assumptions. The number is also MAX_ASSUMPTIONS in packages/core; a test keeps the two equal.
CREATE FUNCTION assumptions_limit_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  max_assumptions CONSTANT integer := 200;
BEGIN
  PERFORM 1 FROM threat_models WHERE id = NEW.threat_model_id FOR NO KEY UPDATE;
  IF (SELECT count(*) FROM assumptions WHERE threat_model_id = NEW.threat_model_id) >= max_assumptions THEN
    RAISE EXCEPTION 'a threat model can hold at most % assumptions', max_assumptions
      USING ERRCODE = 'check_violation', CONSTRAINT = 'assumptions_limit';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER assumptions_limit BEFORE INSERT ON assumptions
  FOR EACH ROW EXECUTE FUNCTION assumptions_limit_check();

-- Provenance: one row for a record an accept created (flag IS NULL) and one for each flag an accept set. A flag has no rationale of its own
-- (Milestone 4 gave a flag citations only), so its row repeats its item's. The record's own delete removes its rows.
CREATE TABLE provenance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  threat_model_id UUID NOT NULL,
  element_id      UUID,
  asset_id        UUID,
  assumption_id   UUID,
  flag            TEXT,
  rationale       TEXT NOT NULL,
  accepted_by     INTEGER NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT provenance_target_check CHECK (num_nonnulls(element_id, asset_id, assumption_id) = 1),
  CONSTRAINT provenance_flag_check CHECK (flag IS NULL OR (element_id IS NOT NULL AND char_length(flag) BETWEEN 1 AND 64)),
  CONSTRAINT provenance_rationale_check CHECK (length(btrim(rationale)) > 0 AND char_length(rationale) <= 300),
  CONSTRAINT provenance_threat_model_id_fkey FOREIGN KEY (threat_model_id) REFERENCES threat_models (id) ON DELETE CASCADE,
  CONSTRAINT provenance_element_fkey FOREIGN KEY (threat_model_id, element_id) REFERENCES elements (threat_model_id, id) ON DELETE CASCADE,
  CONSTRAINT provenance_asset_fkey FOREIGN KEY (threat_model_id, asset_id) REFERENCES assets (threat_model_id, id) ON DELETE CASCADE,
  CONSTRAINT provenance_assumption_fkey FOREIGN KEY (threat_model_id, assumption_id) REFERENCES assumptions (threat_model_id, id) ON DELETE CASCADE,
  -- RESTRICT: an account that accepted something cannot be deleted from under it, as for drafts, sources and jobs.
  CONSTRAINT provenance_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES users (id) ON DELETE RESTRICT
);
-- One row for a record and one per flag. A flag is never empty, so '' stands for "the record itself".
CREATE UNIQUE INDEX provenance_key ON provenance (coalesce(element_id, asset_id, assumption_id), coalesce(flag, ''));
CREATE INDEX provenance_threat_model_idx ON provenance (threat_model_id);

-- A citation of a provenance row, as the draft keeps one: the chunk and the span of the quote inside it, never the quote's text. When the
-- chunk is deleted, `chunk_id` becomes NULL and the page says "Source deleted" (FR-017).
CREATE TABLE provenance_citations (
  provenance_id UUID NOT NULL,
  "position"    SMALLINT NOT NULL,
  chunk_id      UUID,
  quote_start   INTEGER NOT NULL,
  quote_end     INTEGER NOT NULL,
  CONSTRAINT provenance_citations_pkey PRIMARY KEY (provenance_id, "position"),
  CONSTRAINT provenance_citations_position_check CHECK ("position" BETWEEN 0 AND 4),
  -- A chunk holds at most 2,000 code points and a quote at least 12, as in draft_citations.
  CONSTRAINT provenance_citations_span_check CHECK (quote_start >= 0 AND quote_end > quote_start AND quote_end <= 2000 AND quote_end - quote_start >= 12),
  CONSTRAINT provenance_citations_provenance_id_fkey FOREIGN KEY (provenance_id) REFERENCES provenance (id) ON DELETE CASCADE,
  CONSTRAINT provenance_citations_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chunks (id) ON DELETE SET NULL
);
CREATE INDEX provenance_citations_chunk_idx ON provenance_citations (chunk_id) WHERE chunk_id IS NOT NULL;

-- The decision on a draft item. Undecided is every column null. `outcome` says whether an accept created a record or matched one that was
-- there; for a created record the link is to it, and becomes NULL when the record is deleted, which reads as undecided (research #2).
ALTER TABLE draft_items
  ADD COLUMN decision      TEXT,
  ADD COLUMN decided_by    INTEGER,
  ADD COLUMN decided_at    TIMESTAMPTZ,
  ADD COLUMN outcome       TEXT,
  ADD COLUMN element_id    UUID,
  ADD COLUMN asset_id      UUID,
  ADD COLUMN assumption_id UUID;

ALTER TABLE draft_items
  ADD CONSTRAINT draft_items_decision_check CHECK (
    (decision IS NULL) = (decided_by IS NULL) AND (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL OR decision IN ('accepted', 'rejected'))
  ),
  ADD CONSTRAINT draft_items_outcome_check CHECK (
    (decision IS NOT DISTINCT FROM 'accepted') = (outcome IS NOT NULL) AND (outcome IS NULL OR outcome IN ('created', 'matched'))
  ),
  -- A link only when a record was created, and only the one that fits the item's kind.
  ADD CONSTRAINT draft_items_link_check CHECK (
    (element_id IS NULL AND asset_id IS NULL AND assumption_id IS NULL)
    OR (
      outcome = 'created'
      AND num_nonnulls(element_id, asset_id, assumption_id) = 1
      AND (element_id IS NULL OR kind IN ('process', 'data_store', 'external_entity', 'data_flow', 'trust_boundary'))
      AND (asset_id IS NULL OR kind = 'asset')
      AND (assumption_id IS NULL OR kind = 'assumption')
    )
  ),
  ADD CONSTRAINT draft_items_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT draft_items_element_fkey FOREIGN KEY (element_id) REFERENCES elements (id) ON DELETE SET NULL,
  ADD CONSTRAINT draft_items_asset_fkey FOREIGN KEY (asset_id) REFERENCES assets (id) ON DELETE SET NULL,
  ADD CONSTRAINT draft_items_assumption_fkey FOREIGN KEY (assumption_id) REFERENCES assumptions (id) ON DELETE SET NULL;

-- The referencing sides of the three SET NULL keys, so that deleting a record can find the items that point at it.
CREATE INDEX draft_items_element_idx ON draft_items (element_id) WHERE element_id IS NOT NULL;
CREATE INDEX draft_items_asset_idx ON draft_items (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX draft_items_assumption_idx ON draft_items (assumption_id) WHERE assumption_id IS NOT NULL;
