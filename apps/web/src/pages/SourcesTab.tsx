import type { JobsStatus, SourceList, SourceRecord } from '@scrylux/core';
import { useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { isBusySource, useDeleteSource, useRefreshSource, useRetrySource, usePasteSource, useJobsStatus, useSources, useUploadSource } from '../api/queries.js';
import { writeErrorMessage } from '../api/errors.js';
import { progressLabel, time } from '../components/job-format.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LoadError } from '../components/LoadError.js';
import { SourcesNotice, anyHosted } from '../components/SourcesNotice.js';

// The Sources tab of a threat model (Phase 3 Milestone 3, contracts/ui.md): the documents it was built from, what became of each,
// and the form that adds more. Everything about a source that a person or a document chose (its name, its title) is rendered as
// text, never as markup (FR-066). It reads again while a source is waiting or processing, and not otherwise (FR-063).

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** A size as a person reads it: 1.5 KB, 3.2 MB. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function StatusCell({ source }: { source: SourceRecord }) {
  if (source.status === 'waiting') return <>Waiting</>;
  if (source.status === 'processing') return <>Processing{source.progress !== null && `: ${progressLabel(source.progress)}`}</>;
  if (source.status === 'failed' && source.failure !== null) {
    return (
      <>
        <strong>{source.failure.message}</strong>
        <br />
        <span className="muted">{source.failure.hint}</span>
      </>
    );
  }
  const ready = source.ready;
  if (ready === null) return null;
  return (
    <>
      Ready: {plural(ready.chunk_count, 'chunk')}
      {ready.pages_without_text !== null && ready.pages_without_text > 0 && <>, {plural(ready.pages_without_text, 'page')} without text</>}
      {ready.embedding.state === 'out_of_date' && <span className="muted"> Embeddings are out of date.</span>}
      {ready.embedding.state === 'no_provider' && <span className="muted"> No embedding provider is configured.</span>}
      {source.refresh_failure !== null && (
        <>
          <br />
          <strong>{source.refresh_failure.message}</strong>
          <br />
          <span className="muted">{source.refresh_failure.hint}</span>
        </>
      )}
      {source.refresh !== null && (
        <span className="muted">
          {' '}
          Refreshing embeddings{source.refresh.progress !== null && ` (${progressLabel(source.refresh.progress)})`}…
        </span>
      )}
    </>
  );
}

/** What the add form is bound by, so that a refusal is no surprise: the file size, the threat model's count, and the document space (FR-004, FR-005, FR-009). */
function Limits({ limits, count }: { limits: SourceList['limits']; count: number }) {
  return (
    <fieldset className="muted" aria-label="Limits">
      <p>Files up to {sizeText(limits.max_bytes)}</p>
      <p>{count >= limits.per_threat_model ? 'This threat model has reached its limit of documents' : `${count} of ${limits.per_threat_model} documents in this threat model`}</p>
      <p>{limits.used_bytes >= limits.document_space_bytes ? 'The document space is full' : `${sizeText(limits.used_bytes)} of ${sizeText(limits.document_space_bytes)} of document space used`}</p>
    </fieldset>
  );
}

/** Adds files one at a time, in the order chosen, and says what became of each (FR-004). */
function UploadForm({ threatModelId, maxBytes, ai }: { threatModelId: string; maxBytes: number; ai: JobsStatus['ai'] }) {
  const upload = useUploadSource(threatModelId);
  const [files, setFiles] = useState<File[]>([]);
  const [results, setResults] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setSending(true);
    setResults([]);
    const chosen = files;
    for (const file of chosen) {
      // The same words as the server's, so that a refusal reads alike wherever it is made.
      if (file.size > maxBytes) {
        setResults((previous) => [...previous, `${file.name}: The file is larger than ${Math.floor(maxBytes / MB)} MB, the most allowed.`]);
        continue;
      }
      try {
        await upload.mutateAsync(file);
        setResults((previous) => [...previous, `${file.name}: added`]);
      } catch (error) {
        setResults((previous) => [...previous, `${file.name}: ${writeErrorMessage(error)}`]);
      }
    }
    setFiles([]);
    if (input.current) input.current.value = '';
    setSending(false);
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <p>
        <label>
          Files (.md, .txt, .pdf, .docx){' '}
          <input ref={input} type="file" multiple accept=".md,.txt,.pdf,.docx" onChange={(event) => setFiles([...(event.target.files ?? [])])} />
        </label>
      </p>
      <SourcesNotice ai={ai} />
      <p>
        <button type="submit" className="primary" disabled={files.length === 0 || sending}>
          {sending ? 'Uploading…' : 'Upload'}
        </button>
      </p>
      {results.length > 0 && (
        <ul aria-label="Results of the upload">
          {results.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
    </form>
  );
}

function PasteForm({ threatModelId, ai }: { threatModelId: string; ai: JobsStatus['ai'] }) {
  const paste = usePasteSource(threatModelId);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');

  function submit(event: FormEvent): void {
    event.preventDefault();
    paste.mutate(
      { title, text },
      {
        onSuccess: () => {
          setTitle('');
          setText('');
        },
      },
    );
  }

  return (
    <form onSubmit={submit}>
      <p>
        <label>
          Title <input type="text" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </label>
      </p>
      <p>
        <label>
          Text <textarea rows={6} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
      </p>
      <SourcesNotice ai={ai} />
      <p>
        <button type="submit" disabled={title.trim() === '' || text.trim() === '' || paste.isPending}>
          Add text
        </button>
      </p>
      {paste.isError && (
        <p role="alert" className="form-error">
          {writeErrorMessage(paste.error)}
        </p>
      )}
    </form>
  );
}

/** The words of the delete confirmation (contracts/ui.md §3). */
export const deleteQuestion = (name: string): string => `Delete ${name}? Its text and chunks are removed.`;

/** What can be done to one source: try it again where that can help, and delete it, after being asked. */
function Actions({ threatModelId, source }: { threatModelId: string; source: SourceRecord }) {
  const remove = useDeleteSource(threatModelId);
  const retry = useRetrySource(threatModelId);
  const refresh = useRefreshSource(threatModelId);
  const [confirming, setConfirming] = useState(false);
  const retryable = source.failure?.retryable === true || source.refresh_failure?.retryable === true;
  return (
    <>
      {retryable && (
        <>
          <button type="button" aria-label={`Retry ${source.name}`} disabled={retry.isPending} onClick={() => retry.mutate(source.id)}>
            Retry
          </button>{' '}
        </>
      )}
      <button type="button" aria-label={`Delete ${source.name}`} disabled={remove.isPending} onClick={() => setConfirming(true)}>
        Delete
      </button>
      {source.refreshable && (
        <>
          <button type="button" aria-label={`Refresh embeddings of ${source.name}`} disabled={refresh.isPending} onClick={() => refresh.mutate(source.id)}>
            Refresh embeddings
          </button>{' '}
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Delete document"
          message={deleteQuestion(source.name)}
          confirmLabel="Delete"
          onConfirm={() => {
            setConfirming(false);
            remove.mutate(source.id);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
      {retry.isError && (
        <p role="alert" className="form-error">
          {writeErrorMessage(retry.error)}
        </p>
      )}
      {refresh.isError && (
        <p role="alert" className="form-error">
          {writeErrorMessage(refresh.error)}
        </p>
      )}
      {remove.isError && (
        <p role="alert" className="form-error">
          {writeErrorMessage(remove.error)}
        </p>
      )}
    </>
  );
}

export function SourcesTab() {
  const { threatModelId = '' } = useParams();
  const sources = useSources(threatModelId);
  const shown = sources.data?.sources ?? [];
  const busy = shown.some(isBusySource);
  // Whether AI is configured and whether a worker is alive: read again while a source is busy, so that the notice goes away.
  const status = useJobsStatus(busy);
  const noWorker = status.data !== undefined && !status.data.worker_alive && shown.some((source) => source.status === 'waiting');

  return (
    <section aria-labelledby="sources-heading">
      <h2 id="sources-heading">Documents</h2>

      {status.data &&
        (status.data.ai.embedding === null ? (
          <p className="notice">Adding documents needs an embedding provider. Ask the operator to set one up.</p>
        ) : (
          <div className="sources-forms">
            {sources.data && <Limits limits={sources.data.limits} count={shown.length} />}
            <UploadForm threatModelId={threatModelId} maxBytes={sources.data?.limits.max_bytes ?? 10 * MB} ai={status.data.ai} />
            <PasteForm threatModelId={threatModelId} ai={status.data.ai} />
          </div>
        ))}
      {status.isError && <LoadError error={status.error} onRetry={() => void status.refetch()} />}

      {noWorker && (
        <p role="status" className="notice">
          No worker is processing documents. They will be processed when an operator starts one.
        </p>
      )}

      {status.data && anyHosted(status.data.ai) && <SourcesNotice ai={status.data.ai} />}

      {sources.isPending && <p>Loading…</p>}
      {sources.isError && <LoadError error={sources.error} onRetry={() => void sources.refetch()} />}
      {sources.data && shown.length === 0 && <p>No documents yet.</p>}
      {shown.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">Size</th>
                <th scope="col">Added by</th>
                <th scope="col">Added</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((source) => (
                <tr key={source.id}>
                  <td>{source.status === 'ready' ? <Link to={`/threat-models/${threatModelId}/sources/${source.id}`}>{source.name}</Link> : source.name}</td>
                  <td>{source.type}</td>
                  <td>{sizeText(source.size_bytes)}</td>
                  <td>{source.added_by.username}</td>
                  <td>{time(source.added_at)}</td>
                  <td>
                    <StatusCell source={source} />
                  </td>
                  <td>
                    <Actions threatModelId={threatModelId} source={source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
