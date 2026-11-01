import { ChunkRecord, uuid, type SourceRecord } from '@scrylux/core';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useChunks, useDeleteSource, useRefreshSource, useRetrySource, useSource } from '../api/queries.js';
import { isGone, writeErrorMessage } from '../api/errors.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { progressLabel, time } from '../components/job-format.js';
import { LoadError } from '../components/LoadError.js';
import { NotFoundPage } from './NotFoundPage.js';
import { deleteQuestion, sizeText } from './SourcesTab.js';

// One source (Phase 3 Milestone 3, contracts/ui.md): what Scrylux read from a document, so that a reviewer can see exactly what
// each chunk holds and where it came from. The document's name, its text and its headings are rendered as text, never as markup
// (FR-066); a chunk's text keeps its line breaks in a block that does not wrap them away.

const TYPE_LABEL: Record<SourceRecord['type'], string> = { md: 'Markdown', txt: 'Plain text', pdf: 'PDF', docx: 'Word', text: 'Pasted text' };
const EMBEDDING_STATE: Record<string, string> = {
  current: 'Current',
  out_of_date: 'Out of date',
  no_provider: 'No embedding provider is configured',
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Pages 2–3", "Page 4", "Lines 1–9", "Line 9": where in the document a chunk came from. */
function where(chunk: ChunkRecord): string | null {
  const [unit, range] = chunk.pages !== null ? (['Page', chunk.pages] as const) : chunk.lines !== null ? (['Line', chunk.lines] as const) : [null, null];
  if (unit === null || range === null) return null;
  return range.first === range.last ? `${unit} ${range.first}` : `${unit}s ${range.first}–${range.last}`;
}

export function SourcePage() {
  const { threatModelId = '', sourceId = '' } = useParams();
  // A malformed id never reaches the API.
  return uuid.safeParse(sourceId).success ? <SourceView threatModelId={threatModelId} id={sourceId} /> : <NotFoundPage />;
}

function Status({ source }: { source: SourceRecord }) {
  if (source.status === 'waiting') return <>Waiting</>;
  if (source.status === 'processing') return <>Processing{source.progress !== null && `: ${progressLabel(source.progress)}`}</>;
  if (source.status === 'failed') return <>Failed</>;
  return <>Ready</>;
}

function SourceView({ threatModelId, id }: { threatModelId: string; id: string }) {
  const query = useSource(id);
  const source = query.data;
  const ready = source?.status === 'ready';
  const chunks = useChunks(id, ready);
  const remove = useDeleteSource(threatModelId);
  const retry = useRetrySource(threatModelId);
  const refresh = useRefreshSource(threatModelId);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  if (isGone(query.error) && !source) return <NotFoundPage />;
  if (query.isPending) return <p>Loading…</p>;
  if (!source) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  // A source is found through its own threat model's address only.
  if (source.threat_model_id !== threatModelId) return <NotFoundPage />;

  const facts = source.ready;
  const shown = chunks.data?.pages.flatMap((page) => page.chunks) ?? [];

  return (
    <div>
      <p>
        <Link to={`/threat-models/${threatModelId}/sources`}>All documents</Link>
      </p>
      <h1>{source.name}</h1>
      <p>
        {(source.failure?.retryable === true || source.refresh_failure?.retryable === true) && (
          <>
            <button type="button" disabled={retry.isPending} onClick={() => retry.mutate(id)}>
              Retry
            </button>{' '}
          </>
        )}
        {source.refreshable && (
          <>
            <button type="button" disabled={refresh.isPending} onClick={() => refresh.mutate(id)}>
              Refresh embeddings
            </button>{' '}
          </>
        )}
        <button type="button" disabled={remove.isPending} onClick={() => setConfirming(true)}>
          Delete
        </button>
      </p>
      {[retry, refresh, remove].map((mutation, i) =>
        mutation.isError ? (
          <p key={i} role="alert" className="form-error">
            {writeErrorMessage(mutation.error)}
          </p>
        ) : null,
      )}
      {confirming && (
        <ConfirmDialog
          title="Delete document"
          message={deleteQuestion(source.name)}
          confirmLabel="Delete"
          onConfirm={() => {
            setConfirming(false);
            remove.mutate(id, { onSuccess: () => void navigate(`/threat-models/${threatModelId}/sources`) });
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      <dl className="job-facts">
        <dt>Type</dt>
        <dd>{TYPE_LABEL[source.type]}</dd>
        <dt>Size</dt>
        <dd>{sizeText(source.size_bytes)}</dd>
        <dt>Added by</dt>
        <dd>{source.added_by.username}</dd>
        <dt>Added</dt>
        <dd>{time(source.added_at)}</dd>
        <dt>Status</dt>
        <dd>
          <Status source={source} />
        </dd>
        {facts !== null && (
          <>
            <dt>Read</dt>
            <dd>
              {plural(facts.chunk_count, 'chunk')}, {plural(facts.text_chars, 'character')}
            </dd>
            {facts.pages_without_text !== null && facts.pages_without_text > 0 && (
              <>
                <dt>Pages</dt>
                <dd>{plural(facts.pages_without_text, 'page')} without text</dd>
              </>
            )}
            <dt>Embedding model</dt>
            <dd>{`${facts.embedding.model} (${plural(facts.embedding.dimension, 'dimension')})`}</dd>
            <dt>Embeddings</dt>
            <dd>
              {EMBEDDING_STATE[facts.embedding.state] ?? facts.embedding.state}
              {source.refresh !== null && ` · Refreshing${source.refresh.progress !== null ? ` (${progressLabel(source.refresh.progress)})` : ''}…`}
            </dd>
          </>
        )}
      </dl>

      {source.status === 'failed' && source.failure !== null && (
        <p>
          <strong>{source.failure.message}</strong>
          <br />
          <span className="muted">{source.failure.hint}</span>
        </p>
      )}
      {source.refresh_failure !== null && (
        <p>
          <strong>{source.refresh_failure.message}</strong>
          <br />
          <span className="muted">{source.refresh_failure.hint}</span>
        </p>
      )}
      {!ready && source.status !== 'failed' && <p>This document is not ready yet. Its chunks are shown when it is.</p>}
      {source.status === 'failed' && <p>This document was not read, so there are no chunks to show.</p>}

      {ready && (
        <section aria-labelledby="chunks-heading">
          <h2 id="chunks-heading">Chunks</h2>
          {chunks.isPending && <p>Loading…</p>}
          {chunks.isError && <LoadError error={chunks.error} onRetry={() => void chunks.refetch()} />}
          {chunks.data && shown.length === 0 && <p>This document has no chunks.</p>}
          <ol className="chunks">
            {shown.map((chunk) => {
              const place = where(chunk);
              return (
                <li key={chunk.id} aria-label={`Chunk ${chunk.position + 1}`} className="chunk">
                  <h3>{`Chunk ${chunk.position + 1}`}</h3>
                  {(place !== null || chunk.heading !== null) && (
                    <p className="muted">
                      {place !== null && <span>{place}</span>}
                      {place !== null && chunk.heading !== null && ' · '}
                      {chunk.heading !== null && <span>{chunk.heading}</span>}
                    </p>
                  )}
                  <pre className="chunk-text">{chunk.text}</pre>
                </li>
              );
            })}
          </ol>
          {chunks.hasNextPage && (
            <p>
              <button type="button" disabled={chunks.isFetchingNextPage} onClick={() => void chunks.fetchNextPage()}>
                Show more
              </button>
            </p>
          )}
        </section>
      )}
    </div>
  );
}
