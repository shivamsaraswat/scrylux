import { uuid, type JobUsageRecord, type ProviderCheckOperation } from '@scrylux/core';
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router';
import { isActiveJob, useCancelJob, useJob } from '../api/queries.js';
import { isGone, writeErrorMessage } from '../api/errors.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { KIND_LABEL, costText, dollars, failureWords, progressLabel, stateLabel, time, tokenText } from '../components/job-format.js';
import { LoadError } from '../components/LoadError.js';
import { NotFoundPage } from './NotFoundPage.js';

// One job (Phase 3 Milestone 2, contracts/ui.md): who started it and when, the step it is on, and, when it failed, why and
// what to do. It reads again while the job is queued or running and stops once it has ended (FR-061). Everything the API
// sends is rendered as text (FR-066).

// One operation of a provider check (FR-091): the provider, the model, where its data goes, how it ended with the message and
// the hint of a failure, and what it used. It names no key and no address: the API sends none.
function OperationResult({ title, operation, usage }: { title: string; operation: ProviderCheckOperation; usage: JobUsageRecord[] }) {
  const headingId = useId();
  const row = operation.usage_id === undefined ? undefined : usage.find((u) => u.id === operation.usage_id);
  const named = operation.provider !== undefined && operation.model !== undefined;
  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId}>{title}</h3>
      {operation.status === 'not_run' && <p>Not run: the job stopped before this step</p>}
      {operation.status === 'not_configured' && !named && <p>Not configured</p>}
      {named && (
        <>
          <p>{`${operation.provider}, model ${operation.model}`}</p>
          {operation.hosted !== undefined && (
            <p>{operation.hosted ? 'Hosted: data sent to it leaves this install' : 'Local: data sent to it stays in this install'}</p>
          )}
          <p>{operation.status === 'ok' ? 'Worked' : operation.status === 'cancelled' ? 'Cancelled' : `Failed: ${failureWords(operation.status)}`}</p>
          {operation.message !== undefined && <p>{operation.message}</p>}
          {operation.hint !== undefined && <p className="muted">{operation.hint}</p>}
          {row !== undefined && <p>{`${tokenText(row)}, ${row.cost_usd === null ? 'cost unknown' : dollars(row.cost_usd)}`}</p>}
        </>
      )}
    </section>
  );
}

export function JobPage() {
  const { jobId = '' } = useParams();
  // A malformed id never reaches the API.
  return uuid.safeParse(jobId).success ? <JobView id={jobId} /> : <NotFoundPage />;
}

function JobView({ id }: { id: string }) {
  const query = useJob(id);
  const cancel = useCancelJob(id);
  const [confirming, setConfirming] = useState(false);

  if (isGone(query.error) && !query.data) return <NotFoundPage />;
  if (query.isPending) return <p>Loading…</p>;
  if (!query.data) return <LoadError error={query.error} onRetry={() => void query.refetch()} />;
  const job = query.data;

  return (
    <div>
      <p>
        <Link to="/jobs">All jobs</Link>
      </p>
      <h1>{KIND_LABEL[job.kind]}</h1>

      <dl className="job-facts">
        <dt>State</dt>
        <dd>{stateLabel(job)}</dd>
        <dt>Started by</dt>
        <dd>{job.started_by.username}</dd>
        {job.kind !== 'provider_check' && (
          <>
            <dt>Document</dt>
            <dd>
              {job.threat_model_id !== null && job.source_id !== null ? (
                <Link to={`/threat-models/${job.threat_model_id}/sources/${job.source_id}`}>Open the document</Link>
              ) : (
                'The document was deleted'
              )}
            </dd>
          </>
        )}
        <dt>Queued at</dt>
        <dd>{time(job.queued_at)}</dd>
        {job.started_at !== null && (
          <>
            <dt>Started at</dt>
            <dd>{time(job.started_at)}</dd>
          </>
        )}
        {job.finished_at !== null && (
          <>
            <dt>Finished at</dt>
            <dd>{time(job.finished_at)}</dd>
          </>
        )}
        {job.cancelled_by !== null && (
          <>
            <dt>{job.state === 'cancelled' ? 'Cancelled by' : 'Cancel asked by'}</dt>
            <dd>{job.cancelled_by.username}</dd>
          </>
        )}
        {job.next_run_at !== null && (
          <>
            <dt>Next run at</dt>
            <dd>{time(job.next_run_at)}</dd>
          </>
        )}
        <dt>Runs</dt>
        <dd>
          {job.run} of {job.max_runs}
        </dd>
        <dt>Caps</dt>
        <dd>
          Up to {job.caps.tokens} tokens and {dollars(job.caps.cost_usd)}
        </dd>
        {job.totals.requests > 0 && (
          <>
            <dt>Used</dt>
            <dd>{tokenText(job.totals)}</dd>
            <dt>Cost</dt>
            <dd>{costText(job.totals)}</dd>
          </>
        )}
      </dl>
      {job.totals.requests > 0 && !job.totals.cost_cap_applied && (
        <p className="muted">The cost cap could not be applied to every request, because a price was unknown. The token cap was.</p>
      )}

      {isActiveJob(job) && (!job.cancel_requested || job.worker_lost) && (
        <p>
          <button type="button" className="danger" disabled={cancel.isPending} onClick={() => setConfirming(true)}>
            Cancel job
          </button>
        </p>
      )}
      {cancel.isError && <p role="alert" className="form-error">{writeErrorMessage(cancel.error)}</p>}
      {confirming && (
        <ConfirmDialog
          title="Cancel this job?"
          message="It stops as soon as it can. What it has used so far is kept, and it will not run again."
          confirmLabel="Cancel the job"
          cancelLabel="Keep running"
          onConfirm={() => {
            setConfirming(false);
            cancel.mutate();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}

      {job.worker_lost && isActiveJob(job) && (
        <p className="notice">Its worker was lost. It will run again when a worker picks it up, or cancel it to end it now.</p>
      )}

      {job.state === 'running' && job.progress !== null && !job.worker_lost && <p>{progressLabel(job.progress)}</p>}

      {job.failure !== null && (
        <div role="alert" className="notice">
          <p>
            <strong>{job.failure.message}</strong>
          </p>
          <p>{job.failure.hint}</p>
          <p className="muted">Reason: {failureWords(job.failure.category)}</p>
        </div>
      )}

      {job.result !== null && (
        <section aria-labelledby="result-heading">
          <h2 id="result-heading">Result</h2>
          <OperationResult title="Generation" operation={job.result.generation} usage={job.usage} />
          <OperationResult title="Embeddings" operation={job.result.embeddings} usage={job.usage} />
        </section>
      )}

      {job.ingestion !== null && (
        <section aria-labelledby="ingestion-heading">
          <h2 id="ingestion-heading">Result</h2>
          <p>{`${job.ingestion.chunks} ${job.ingestion.chunks === 1 ? 'chunk' : 'chunks'}`}</p>
          {job.ingestion.pages_without_text !== null && job.ingestion.pages_without_text > 0 && (
            <p>{`${job.ingestion.pages_without_text} ${job.ingestion.pages_without_text === 1 ? 'page' : 'pages'} without text`}</p>
          )}
        </section>
      )}

      {job.usage.length > 0 && (
        <section aria-labelledby="usage-heading">
          <h2 id="usage-heading">Requests</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Model</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {job.usage.map((row) => (
                  <tr key={row.id}>
                    <td>{row.run}</td>
                    <td>{row.operation === 'generate' ? 'Generation' : 'Embeddings'}</td>
                    <td>{`${row.provider} / ${row.model}`}</td>
                    <td>{failureWords(row.outcome)}</td>
                    <td>{tokenText({ input_tokens: row.input_tokens, output_tokens: row.output_tokens, tokens_estimated: row.tokens_estimated })}</td>
                    <td>{row.cost_usd === null ? 'cost unknown' : dollars(row.cost_usd)}</td>
                    <td>{(row.duration_ms / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
