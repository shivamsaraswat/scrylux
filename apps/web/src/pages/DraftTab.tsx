import type { DraftRecord, ExtractionStatus } from '@scrylux/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { writeErrorMessage } from '../api/errors.js';
import { isActiveJob, keys, useDiscardDraft, useDraft, useExtraction, useJobsStatus, useSources, useStartExtraction } from '../api/queries.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ExtractionNotice } from '../components/ExtractionNotice.js';
import { progressLabel, readSummary, time } from '../components/job-format.js';
import { LoadError } from '../components/LoadError.js';
import { DraftDiagram } from '../draft/DraftDiagram.js';
import { DraftList } from '../draft/DraftList.js';
import { ItemPanel } from '../draft/ItemPanel.js';
import { draftItems } from '../draft/draft-items.js';
import '../draft/draft.css';

// The Draft tab of a threat model (Phase 3 Milestone 4, contracts/ui.md "The Draft tab"): start an extraction, follow it, and read the
// draft it made. A draft is what a model proposed from the sources. It is marked as such wherever it is shown, it is read-only, and it
// is not part of the threat model: nothing on this tab changes the diagram or the threats (FR-050, FR-061). Every text of it is rendered
// as text, never as markup (FR-066).

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The control that starts an extraction, or the reason it cannot be started, or the extraction that is under way. */
function StartControl({
  threatModelId,
  extraction,
  hasDraft,
  unfinished,
  noWorker,
}: {
  threatModelId: string;
  extraction: ExtractionStatus;
  hasDraft: boolean;
  unfinished: string[];
  noWorker: boolean;
}) {
  const start = useStartExtraction(threatModelId);
  const latest = extraction.latest;

  if (latest !== null && isActiveJob(latest)) {
    return (
      <div role="status" className="draft-progress">
        <p>{latest.state === 'queued' ? 'Queued' : latest.progress !== null ? progressLabel(latest.progress) : 'Running'}</p>
        <p>
          <Link to={`/jobs/${latest.id}`}>Open the job</Link>
        </p>
        {(noWorker || latest.worker_lost) && <p className="notice">No worker is processing jobs. The extraction will run when an operator starts one.</p>}
      </div>
    );
  }

  const { start: offer } = extraction;
  if (!offer.offered) {
    return (
      <div>
        <p>{offer.message}</p>
        {offer.reason === 'sources_processing' && unfinished.length > 0 && (
          <ul aria-label="Sources still being processed">
            {unfinished.map((name, index) => (
              <li key={index}>{name}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div>
      {offer.path === 'retrieval' && (
        <p className="muted">
          These sources are larger than the extraction budget. Scrylux will read part of them, choosing the chunks most relevant to a system model.
        </p>
      )}
      {(offer.replaces_draft || hasDraft) && <p className="muted">When it succeeds, the new draft replaces the draft below.</p>}
      <button type="button" disabled={start.isPending} onClick={() => start.mutate()}>
        Start extraction
      </button>
      {start.isError && <p role="alert">{writeErrorMessage(start.error)}</p>}
    </div>
  );
}

/** What the draft read, the model that made it, and what has changed since (FR-014, FR-053, FR-054, FR-062). */
function WhatItRead({ draft }: { draft: DraftRecord }) {
  const read = draft.sources.filter((source) => source.read);
  const leftOut = draft.sources.filter((source) => !source.read);
  return (
    <section aria-label="What the draft read">
      <p>{readSummary({ path: draft.path, chunks_read: draft.chunks_read, chunks_available: draft.chunks_available, sources_read: read.length })}</p>
      {leftOut.length > 0 && (
        <p>
          Left out because {leftOut.length === 1 ? 'it was' : 'they were'} not ready: {leftOut.map((source) => source.name).join(', ')}
        </p>
      )}
      <p className="muted">
        Made by {draft.generation_model} on {time(draft.made_at)}. Started by {draft.started_by.username}.
      </p>
      {draft.sources_changed && <p role="status">The sources have changed since this draft was made.</p>}
      {draft.sources_deleted > 0 && (
        <p role="status">
          {plural(draft.sources_deleted, 'source', 'sources')} that the draft read {draft.sources_deleted === 1 ? 'has' : 'have'} been deleted.
        </p>
      )}
    </section>
  );
}

function Draft({ draft, threatModelId }: { draft: DraftRecord; threatModelId: string }) {
  const discard = useDiscardDraft(threatModelId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const items = useMemo(() => draftItems(draft), [draft]);
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return (
    <section aria-label="Draft">
      <p role="note" aria-label="Draft status" className="notice">
        Draft proposed by AI. It is not part of this threat model. Nothing here changes the threat model’s diagram or threats.
      </p>
      <WhatItRead draft={draft} />
      {draft.nothing_found !== null ? (
        <p>{draft.nothing_found}</p>
      ) : (
        <div className="draft-view">
          <div>
            <DraftDiagram elements={draft.elements} selectedId={selectedId} onSelect={setSelectedId} />
            <DraftList items={items} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
          <ItemPanel item={selected} threatModelId={threatModelId} />
        </div>
      )}
      <p>
        <button type="button" disabled={discard.isPending} onClick={() => setConfirming(true)}>
          Discard draft
        </button>
      </p>
      {discard.isError && <p role="alert">{writeErrorMessage(discard.error)}</p>}
      {confirming && (
        <ConfirmDialog
          title="Discard this draft?"
          message="The draft is deleted. The threat model is not changed. You can start another extraction."
          confirmLabel="Discard"
          onConfirm={() => {
            setConfirming(false);
            discard.mutate();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

export function DraftTab() {
  const { threatModelId = '' } = useParams();
  const client = useQueryClient();
  const extraction = useExtraction(threatModelId);
  const draft = useDraft(threatModelId);
  const sources = useSources(threatModelId);
  const latest = extraction.data?.latest ?? null;
  const active = latest !== null && isActiveJob(latest);
  const status = useJobsStatus(active);

  // When an extraction ends, what it changed is read: the draft it made, and the sources it read (FR-063).
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) {
      void client.invalidateQueries({ queryKey: keys.draft(threatModelId) });
      void client.invalidateQueries({ queryKey: keys.sources(threatModelId) });
    }
    wasActive.current = active;
  }, [active, client, threatModelId]);

  if (extraction.isError) return <LoadError error={extraction.error} onRetry={() => void extraction.refetch()} />;
  // The control is shown with the notice that says where the text goes, never without it (FR-070).
  const ready = extraction.data !== undefined && status.data !== undefined;
  const unfinishedIds = extraction.data?.start.offered === false ? extraction.data.start.source_ids : [];
  const unfinished = (sources.data?.sources ?? []).filter((source) => unfinishedIds.includes(source.id)).map((source) => source.name);

  return (
    <div>
      {ready && <ExtractionNotice generation={status.data.ai.generation} />}
      {ready && (
        <StartControl
          threatModelId={threatModelId}
          extraction={extraction.data}
          hasDraft={draft.data !== null && draft.data !== undefined}
          unfinished={unfinished}
          noWorker={!status.data.worker_alive && latest?.state === 'queued'}
        />
      )}
      {latest !== null && !active && latest.state === 'failed' && latest.failure !== null && (
        <div role="alert">
          <strong>{latest.failure.message}</strong>
          <br />
          <span className="muted">{latest.failure.hint}</span>
        </div>
      )}
      {latest !== null && !active && latest.state === 'cancelled' && (
        <p>{draft.data ? 'The last extraction was cancelled. The draft below is the one before it.' : 'The last extraction was cancelled.'}</p>
      )}
      {draft.isError && <LoadError error={draft.error} onRetry={() => void draft.refetch()} />}
      {draft.data && <Draft draft={draft.data} threatModelId={threatModelId} />}
    </div>
  );
}
