import type { MitigationRecord } from '@scrylux/core';
import { useState } from 'react';
import { writeErrorMessage } from '../api/errors.js';
import { useCreateMitigation, useDeleteMitigation, useUpdateMitigation } from '../api/queries.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ErrorSummary } from './ErrorSummary.js';
import { MitigationForm } from './MitigationForm.js';
import { TicketLink } from './TicketLink.js';

interface MitigationListProps {
  threatId: string;
  threatModelId: string;
  mitigations: MitigationRecord[];
}

// The mitigations of one threat, shown in its expanded row: add, edit and delete (spec FR-013).
export function MitigationList({ threatId, threatModelId, mitigations }: MitigationListProps) {
  const create = useCreateMitigation(threatModelId);
  const update = useUpdateMitigation(threatModelId);
  const remove = useDeleteMitigation(threatModelId);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onDelete(id: string): Promise<void> {
    setDeletingId(null);
    setError(null);
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      setError(writeErrorMessage(err));
    }
  }

  return (
    <div>
      <ErrorSummary message={error} />
      {mitigations.length === 0 && <p>No mitigations yet.</p>}
      {mitigations.length > 0 && (
        <ul>
          {mitigations.map((mitigation) =>
            editingId === mitigation.id ? (
              <li key={mitigation.id}>
                <MitigationForm
                  threatId={threatId}
                  initial={mitigation}
                  onSubmit={async (input) => {
                    await update.mutateAsync({ id: mitigation.id, input });
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={mitigation.id}>
                <p>{mitigation.description}</p>
                <p className="muted">
                  <span>{mitigation.status}</span>
                  {mitigation.external_ref && (
                    <>
                      {' · '}
                      <TicketLink url={mitigation.external_ref} />
                    </>
                  )}
                </p>
                <div className="actions">
                  <button type="button" onClick={() => setEditingId(mitigation.id)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => setDeletingId(mitigation.id)}>
                    Delete
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {adding ? (
        <MitigationForm
          threatId={threatId}
          onSubmit={async (input) => {
            await create.mutateAsync(input as Parameters<typeof create.mutateAsync>[0]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>
          Add mitigation
        </button>
      )}
      {deletingId && (
        <ConfirmDialog
          title="Delete mitigation"
          message="Delete this mitigation?"
          confirmLabel="Delete"
          onConfirm={() => void onDelete(deletingId)}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}
