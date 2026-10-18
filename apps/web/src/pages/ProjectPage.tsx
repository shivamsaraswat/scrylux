import { uuid } from '@scrylux/core';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  useCreateThreatModel,
  useDeleteProject,
  useProject,
  useThreatModels,
  useUpdateProject,
} from '../api/queries.js';
import { GONE_MESSAGE, isGone, writeErrorMessage } from '../api/errors.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ErrorSummary } from '../components/ErrorSummary.js';
import { ImportThreatModel } from '../components/ImportThreatModel.js';
import { LoadError } from '../components/LoadError.js';
import { ProjectForm } from '../components/ProjectForm.js';
import { ThreatModelForm } from '../components/ThreatModelForm.js';
import { NotFoundPage } from './NotFoundPage.js';

const statusLabel = (status: string): string => status.replace('_', ' ');

export function ProjectPage() {
  const { projectId = '' } = useParams();
  // A malformed id never reaches the API.
  return uuid.safeParse(projectId).success ? <ProjectView id={projectId} /> : <NotFoundPage />;
}

function ProjectView({ id }: { id: string }) {
  const project = useProject(id);
  const navigate = useNavigate();
  const update = useUpdateProject(id);
  const remove = useDeleteProject(id);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const gone = isGone(project.error);
  if (gone && !project.data) return <NotFoundPage />;
  if (project.isPending) return <p>Loading…</p>;
  if (!project.data) return <LoadError error={project.error} onRetry={() => void project.refetch()} />;
  const record = project.data;

  async function onDelete(): Promise<void> {
    setConfirming(false);
    setDeleteError(null);
    try {
      await remove.mutateAsync();
      void navigate('/projects', { replace: true });
    } catch (err) {
      setDeleteError(writeErrorMessage(err));
    }
  }

  return (
    <div>
      <nav aria-label="Breadcrumb">
        <Link to="/projects">Projects</Link> / {record.name}
      </nav>
      <ErrorSummary message={gone ? GONE_MESSAGE : deleteError} />
      {editing ? (
        <ProjectForm
          initial={record}
          onSubmit={async (input) => {
            await update.mutateAsync(input);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <h1>{record.name}</h1>
          {record.description && <p>{record.description}</p>}
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
          title="Delete project"
          message={`Delete project "${record.name}"? This permanently deletes its threat models and everything in them.`}
          confirmLabel="Delete"
          onConfirm={() => void onDelete()}
          onCancel={() => setConfirming(false)}
        />
      )}
      <ThreatModels projectId={id} />
    </div>
  );
}

function ThreatModels({ projectId }: { projectId: string }) {
  const models = useThreatModels(projectId);
  const create = useCreateThreatModel(projectId);
  const [creating, setCreating] = useState(false);

  return (
    <section aria-labelledby="threat-models-heading">
      <h2 id="threat-models-heading">Threat models</h2>
      {creating ? (
        <ThreatModelForm
          projectId={projectId}
          onSubmit={async (input) => {
            await create.mutateAsync(input as Parameters<typeof create.mutateAsync>[0]);
            setCreating(false);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          New threat model
        </button>
      )}
      <ImportThreatModel projectId={projectId} />
      {models.isPending && <p>Loading…</p>}
      {models.isError && <LoadError error={models.error} onRetry={() => void models.refetch()} />}
      {models.data && models.data.length === 0 && <p>No threat models yet.</p>}
      {models.data && models.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Methodology</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {models.data.map((model) => (
                <tr key={model.id}>
                  <td>
                    <Link to={`/threat-models/${model.id}`}>{model.name}</Link>
                  </td>
                  <td>{model.methodology}</td>
                  <td>{statusLabel(model.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
