import { THREAT_MODEL_STATUSES, uuid, type ThreatModelStatus } from '@scrylux/core';
import { useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { GONE_MESSAGE, isGone, writeErrorMessage } from '../api/errors.js';
import { useDeleteThreatModel, useProject, useThreatModel, useUpdateThreatModel } from '../api/queries.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ErrorSummary } from '../components/ErrorSummary.js';
import { DiagramEditorProvider } from '../diagram/DiagramEditorProvider.js';
import { LeaveGuard } from '../diagram/LeaveGuard.js';
import { ExportModel } from '../components/ExportModel.js';
import { ExportReport } from '../components/ExportReport.js';
import { ImportLeftOut } from '../components/ImportLeftOut.js';
import { GenerateThreats } from '../components/GenerateThreats.js';
import { FormField } from '../components/FormField.js';
import { LoadError } from '../components/LoadError.js';
import { ThreatModelForm } from '../components/ThreatModelForm.js';
import { NotFoundPage } from './NotFoundPage.js';

const statusLabel = (status: string): string => status.replace('_', ' ');

export function ThreatModelPage() {
  const { threatModelId = '' } = useParams();
  // A malformed id never reaches the API.
  return uuid.safeParse(threatModelId).success ? <ThreatModelView id={threatModelId} /> : <NotFoundPage />;
}

function ThreatModelView({ id }: { id: string }) {
  const model = useThreatModel(id);
  const projectId = model.data?.project_id;
  const project = useProject(projectId);
  const update = useUpdateThreatModel(id, projectId);
  const remove = useDeleteThreatModel(id, projectId);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  // A record that never loaded and is gone is a page that doesn't exist. One that was shown and then
  // deleted elsewhere keeps the page, with the message, so nothing disappears without an explanation.
  const gone = isGone(model.error);
  if (gone && !model.data) return <NotFoundPage />;
  if (model.isPending) return <p>Loading…</p>;
  if (!model.data) return <LoadError error={model.error} onRetry={() => void model.refetch()} />;
  const record = model.data;

  async function changeStatus(status: ThreatModelStatus): Promise<void> {
    setActionError(null);
    try {
      await update.mutateAsync({ status });
    } catch (err) {
      setActionError(writeErrorMessage(err));
    }
  }

  async function onDelete(): Promise<void> {
    setConfirming(false);
    setActionError(null);
    try {
      await remove.mutateAsync();
      void navigate(`/projects/${record.project_id}`, { replace: true });
    } catch (err) {
      setActionError(writeErrorMessage(err));
    }
  }

  return (
    <div>
      <nav aria-label="Breadcrumb">
        <Link to="/projects">Projects</Link>
        {project.data && (
          <>
            {' / '}
            <Link to={`/projects/${project.data.id}`}>{project.data.name}</Link>
          </>
        )}
        {' / '}
        {record.name}
      </nav>
      <ErrorSummary message={gone ? GONE_MESSAGE : actionError} />
      <ImportLeftOut returnFocusTo={title} />
      {editing ? (
        <ThreatModelForm
          initial={record}
          onSubmit={async (input) => {
            await update.mutateAsync(input);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <h1 ref={title} tabIndex={-1}>
            {record.name}
          </h1>
          <p>
            Methodology: <span>{record.methodology}</span>
          </p>
          <FormField id="threat-model-status" label="Status">
            {(control) => (
              <select
                {...control}
                // The value is the server's, not the attempted one: it only changes after a refetch.
                value={record.status}
                disabled={update.isPending}
                onChange={(event) => void changeStatus(event.target.value as ThreatModelStatus)}
              >
                {THREAT_MODEL_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <div className="actions">
            <button type="button" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="danger" onClick={() => setConfirming(true)}>
              Delete
            </button>
          </div>
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title="Delete threat model"
          message={`Delete threat model "${record.name}"? This permanently deletes its elements, threats, mitigations and documents.`}
          confirmLabel="Delete"
          onConfirm={() => void onDelete()}
          onCancel={() => setConfirming(false)}
        />
      )}
      <nav aria-label="Threat model views" className="tabs">
        <NavLink to={`/threat-models/${id}/diagram`}>Diagram</NavLink>
        <NavLink to={`/threat-models/${id}`} end>
          Threats
        </NavLink>
        <NavLink to={`/threat-models/${id}/sources`}>Sources</NavLink>
      </nav>
      <DiagramEditorProvider key={id} threatModelId={id}>
        <GenerateThreats threatModelId={id} />
        <ExportReport threatModelId={id} />
        <ExportModel threatModelId={id} />
        <LeaveGuard />
        <Outlet />
      </DiagramEditorProvider>
    </div>
  );
}
