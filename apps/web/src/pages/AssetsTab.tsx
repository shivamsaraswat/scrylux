import type { AssetRecord, AssetUpdate, AssumptionRecord, AssumptionUpdate, ElementRecord, ProvenanceRecord } from '@scrylux/core';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { writeErrorMessage } from '../api/errors.js';
import { useAssets, useAssumptions, useCreateAsset, useCreateAssumption, useDeleteAsset, useDeleteAssumption, useElements, useProvenance, useUpdateAsset, useUpdateAssumption } from '../api/queries.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LoadError } from '../components/LoadError.js';
import { ProvenanceNotice } from '../components/ProvenanceNotice.js';

// The Assets tab (Phase 3 Milestone 5, contracts/ui.md "The Assets tab"): the threat model's assets, with the elements that hold each, and its assumptions. A
// person can add, edit and delete either, whatever its origin (FR-021). The API's refusals (a repeated name, a full section) are shown beside the form. Every text
// is rendered as text (Principle VI).

const HOLDER_TYPES = ['process', 'data_store', 'external_entity'];

interface AssetFormValues {
  name: string;
  description: string;
  holderIds: string[];
}

function AssetForm({
  label,
  initial,
  nodes,
  pending,
  error,
  onSave,
  onCancel,
}: {
  label: 'Add asset' | 'Edit asset';
  initial: AssetFormValues;
  nodes: readonly ElementRecord[];
  pending: boolean;
  error: string | null;
  onSave: (values: AssetFormValues) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [holderIds, setHolderIds] = useState(initial.holderIds);
  return (
    <form
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ name, description, holderIds });
      }}
    >
      <p>
        <label>
          Name <input type="text" value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
      </p>
      <p>
        <label>
          Description <textarea value={description} onChange={(event) => setDescription(event.target.value)} required />
        </label>
      </p>
      <fieldset>
        <legend>Held by</legend>
        {nodes.map((node) => (
          <p key={node.id}>
            <label>
              <input
                type="checkbox"
                checked={holderIds.includes(node.id)}
                onChange={() => setHolderIds((now) => (now.includes(node.id) ? now.filter((id) => id !== node.id) : [...now, node.id]))}
              />{' '}
              {node.name}
            </label>
          </p>
        ))}
      </fieldset>
      {error !== null && <p role="alert">{error}</p>}
      <p>
        <button type="submit" disabled={pending}>
          Save
        </button>{' '}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}

function AssetsSection({ threatModelId, assets, elements, provenance }: { threatModelId: string; assets: readonly AssetRecord[]; elements: readonly ElementRecord[]; provenance: readonly ProvenanceRecord[] }) {
  const create = useCreateAsset(threatModelId);
  const update = useUpdateAsset(threatModelId);
  const remove = useDeleteAsset(threatModelId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AssetRecord | null>(null);
  const nodes = elements.filter((element) => HOLDER_TYPES.includes(element.type));
  const nameOf = (id: string): string => elements.find((element) => element.id === id)?.name ?? 'an element';

  return (
    <section aria-label="Assets">
      <h3>Assets</h3>
      {assets.length === 0 && <p className="muted">No assets yet. An asset is something of value that the system stores or carries. Add one here, or accept one from a draft.</p>}
      <ul>
        {assets.map((asset) =>
          editing === asset.id ? (
            <li key={asset.id}>
              <AssetForm
                label="Edit asset"
                initial={{ name: asset.name, description: asset.description, holderIds: asset.holder_ids }}
                nodes={nodes}
                pending={update.isPending}
                error={update.isError ? writeErrorMessage(update.error) : null}
                onCancel={() => setEditing(null)}
                onSave={(values) => {
                  const changes: AssetUpdate = {};
                  if (values.name !== asset.name) changes.name = values.name;
                  if (values.description !== asset.description) changes.description = values.description;
                  if (values.holderIds.length !== asset.holder_ids.length || values.holderIds.some((id) => !asset.holder_ids.includes(id))) changes.holder_ids = values.holderIds;
                  if (Object.keys(changes).length === 0) return setEditing(null);
                  update.mutate({ id: asset.id, changes }, { onSuccess: () => setEditing(null) });
                }}
              />
            </li>
          ) : (
            <li key={asset.id}>
              <h4>{asset.name}</h4>
              <p>{asset.description}</p>
              <ProvenanceNotice marks={provenance.filter((mark) => mark.target.kind === 'asset' && mark.target.id === asset.id)} threatModelId={threatModelId} />
              {asset.holder_ids.length > 0 && (
                <p>
                  Held by{' '}
                  {asset.holder_ids.map((id, index) => (
                    <span key={id}>
                      {index > 0 && ', '}
                      <Link to={`/threat-models/${threatModelId}/diagram?element=${id}`}>{nameOf(id)}</Link>
                    </span>
                  ))}
                </p>
              )}
              <p>
                <button type="button" aria-label={`Edit ${asset.name}`} onClick={() => setEditing(asset.id)}>
                  Edit
                </button>{' '}
                <button type="button" aria-label={`Delete ${asset.name}`} onClick={() => setDeleting(asset)}>
                  Delete
                </button>
              </p>
            </li>
          ),
        )}
      </ul>
      {adding ? (
        <AssetForm
          label="Add asset"
          initial={{ name: '', description: '', holderIds: [] }}
          nodes={nodes}
          pending={create.isPending}
          error={create.isError ? writeErrorMessage(create.error) : null}
          onCancel={() => setAdding(false)}
          onSave={(values) => create.mutate({ name: values.name, description: values.description, holder_ids: values.holderIds }, { onSuccess: () => setAdding(false) })}
        />
      ) : (
        <p>
          <button type="button" onClick={() => setAdding(true)}>
            Add asset
          </button>
        </p>
      )}
      {remove.isError && <p role="alert">{writeErrorMessage(remove.error)}</p>}
      {deleting !== null && (
        <ConfirmDialog
          title="Delete this asset?"
          message="The asset is deleted from the threat model. The elements that held it are not changed."
          confirmLabel="Delete"
          onConfirm={() => {
            remove.mutate(deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function AssumptionForm({ label, initial, pending, error, onSave, onCancel }: { label: string; initial: string; pending: boolean; error: string | null; onSave: (statement: string) => void; onCancel: () => void }) {
  const [statement, setStatement] = useState(initial);
  return (
    <form
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(statement);
      }}
    >
      <p>
        <label>
          Statement <textarea value={statement} onChange={(event) => setStatement(event.target.value)} required />
        </label>
      </p>
      {error !== null && <p role="alert">{error}</p>}
      <p>
        <button type="submit" disabled={pending}>
          Save
        </button>{' '}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}

function AssumptionsSection({ threatModelId, assumptions, provenance }: { threatModelId: string; assumptions: readonly AssumptionRecord[]; provenance: readonly ProvenanceRecord[] }) {
  const create = useCreateAssumption(threatModelId);
  const update = useUpdateAssumption(threatModelId);
  const remove = useDeleteAssumption(threatModelId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AssumptionRecord | null>(null);

  return (
    <section aria-label="Assumptions">
      <h3>Assumptions</h3>
      {assumptions.length === 0 && <p className="muted">No assumptions yet. An assumption is something the design relies on. Add one here, or accept one from a draft.</p>}
      <ul>
        {assumptions.map((assumption) =>
          editing === assumption.id ? (
            <li key={assumption.id}>
              <AssumptionForm
                label="Edit assumption"
                initial={assumption.statement}
                pending={update.isPending}
                error={update.isError ? writeErrorMessage(update.error) : null}
                onCancel={() => setEditing(null)}
                onSave={(statement) => {
                  const changes: AssumptionUpdate = { statement };
                  if (statement === assumption.statement) return setEditing(null);
                  update.mutate({ id: assumption.id, changes }, { onSuccess: () => setEditing(null) });
                }}
              />
            </li>
          ) : (
            <li key={assumption.id}>
              <p>{assumption.statement}</p>
              <ProvenanceNotice marks={provenance.filter((mark) => mark.target.kind === 'assumption' && mark.target.id === assumption.id)} threatModelId={threatModelId} />
              <p>
                <button type="button" aria-label={`Edit ${assumption.statement}`} onClick={() => setEditing(assumption.id)}>
                  Edit
                </button>{' '}
                <button type="button" aria-label={`Delete ${assumption.statement}`} onClick={() => setDeleting(assumption)}>
                  Delete
                </button>
              </p>
            </li>
          ),
        )}
      </ul>
      {adding ? (
        <AssumptionForm
          label="Add assumption"
          initial=""
          pending={create.isPending}
          error={create.isError ? writeErrorMessage(create.error) : null}
          onCancel={() => setAdding(false)}
          onSave={(statement) => create.mutate({ statement }, { onSuccess: () => setAdding(false) })}
        />
      ) : (
        <p>
          <button type="button" onClick={() => setAdding(true)}>
            Add assumption
          </button>
        </p>
      )}
      {remove.isError && <p role="alert">{writeErrorMessage(remove.error)}</p>}
      {deleting !== null && (
        <ConfirmDialog
          title="Delete this assumption?"
          message="The assumption is deleted from the threat model."
          confirmLabel="Delete"
          onConfirm={() => {
            remove.mutate(deleting.id);
            setDeleting(null);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

export function AssetsTab() {
  const { threatModelId = '' } = useParams();
  const assets = useAssets(threatModelId);
  const assumptions = useAssumptions(threatModelId);
  const elements = useElements(threatModelId);
  const provenance = useProvenance(threatModelId);
  if (assets.isError) return <LoadError error={assets.error} onRetry={() => void assets.refetch()} />;
  if (assumptions.isError) return <LoadError error={assumptions.error} onRetry={() => void assumptions.refetch()} />;
  if (assets.data === undefined || assumptions.data === undefined) return <p>Loading…</p>;
  return (
    <div>
      <AssetsSection threatModelId={threatModelId} assets={assets.data} elements={elements.data ?? []} provenance={provenance.data ?? []} />
      <AssumptionsSection threatModelId={threatModelId} assumptions={assumptions.data} provenance={provenance.data ?? []} />
    </div>
  );
}
