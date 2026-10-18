import { describeStale, type ElementRecord, type MitigationRecord, type ThreatRecord, type ThreatUpdateInput } from '@scrylux/core';
import { Fragment, useMemo, useState } from 'react';
import { writeErrorMessage } from '../api/errors.js';
import { useDeleteThreat, useUpdateThreat } from '../api/queries.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ErrorSummary } from './ErrorSummary.js';
import { MitigationList } from './MitigationList.js';
import { StatusControl } from './StatusControl.js';
import { ThreatForm } from './ThreatForm.js';

interface ThreatTableProps {
  threatModelId: string;
  threats: ThreatRecord[];
  // Every mitigation of the threat model, from one request. They are grouped by threat here.
  mitigations: MitigationRecord[];
  elements: ElementRecord[];
  // The Element column is left out where every row is for the same element (the diagram's panel).
  showElement?: boolean;
  // Called after a threat has been changed from its row and the list read again, so whoever filters the list can
  // see whether the row still belongs in it.
  onRowSaved?: (threatId: string) => void;
}

const COLUMNS = ['Title', 'Category', 'Likelihood', 'Impact', 'Risk', 'Status', 'Element', 'Source', 'Mitigations', 'Actions'];
const COMES_BACK =
  'Generating threats again will create it again while its rule applies. To dismiss it for good, set its status to Not applicable, with a reason, instead.';

// The threats of a threat model. A threat model of 1,000 threats and 2,000 mitigations stays usable
// without virtualization (SC-004): mitigations are grouped once, and rendered only for expanded rows.
// All text is rendered as text, never as markup (spec FR-017).
export function ThreatTable({ threatModelId, threats, mitigations, elements, showElement = true, onRowSaved }: ThreatTableProps) {
  const update = useUpdateThreat(threatModelId);
  const remove = useDeleteThreat(threatModelId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreatRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byThreat = useMemo(() => {
    const groups = new Map<string, MitigationRecord[]>();
    for (const mitigation of mitigations) {
      const group = groups.get(mitigation.threat_id);
      if (group) group.push(mitigation);
      else groups.set(mitigation.threat_id, [mitigation]);
    }
    return groups;
  }, [mitigations]);
  const elementNames = useMemo(() => new Map(elements.map((element) => [element.id, element.name])), [elements]);

  function expand(id: string): void {
    setExpanded((previous) => new Set(previous).add(id));
  }

  function toggle(id: string): void {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function onDelete(threat: ThreatRecord): Promise<void> {
    setDeleting(null);
    setError(null);
    try {
      await remove.mutateAsync(threat.id);
    } catch (err) {
      setError(writeErrorMessage(err));
    }
  }

  if (threats.length === 0) return <p>No threats yet.</p>;

  const columns = showElement ? COLUMNS : COLUMNS.filter((column) => column !== 'Element');

  const deletingCount = deleting ? (byThreat.get(deleting.id)?.length ?? 0) : 0;

  return (
    <div className="table-wrap">
      <ErrorSummary message={error} />
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {threats.map((threat) => {
            const own = byThreat.get(threat.id) ?? [];
            const open = expanded.has(threat.id);
            const panelId = `mitigations-${threat.id}`;
            return (
              <Fragment key={threat.id}>
                <tr>
                  <td>
                    {threat.title}
                    {threat.stale && (
                      <>
                        <strong className="badge stale">Stale</strong>
                        <p className="stale-reason">{describeStale(threat.stale)}</p>
                      </>
                    )}
                  </td>
                  <td>{threat.category}</td>
                  <td>{threat.likelihood}</td>
                  <td>{threat.impact}</td>
                  <td>{threat.risk}</td>
                  <td>
                    <StatusControl
                      threat={threat}
                      mitigations={own}
                      threatModelId={threatModelId}
                      onOpenMitigations={() => expand(threat.id)}
                      onSaved={() => onRowSaved?.(threat.id)}
                    />
                  </td>
                  {showElement && <td>{(threat.element_id && elementNames.get(threat.element_id)) || '—'}</td>}
                  <td>
                    {threat.origin === 'manual' ? (
                      'Manual'
                    ) : threat.origin === 'rule' ? (
                      <>
                        Rule <code>{threat.library_ref}</code>
                      </>
                    ) : (
                      threat.origin
                    )}
                  </td>
                  <td>
                    <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => toggle(threat.id)}>
                      {own.length} {own.length === 1 ? 'mitigation' : 'mitigations'}
                    </button>
                  </td>
                  <td>
                    <div className="actions">
                      <button type="button" aria-label={`Edit threat ${threat.title}`} onClick={() => setEditingId(threat.id)}>
                        Edit
                      </button>
                      <button type="button" className="danger" aria-label={`Delete threat ${threat.title}`} onClick={() => setDeleting(threat)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
                {editingId === threat.id && (
                  <tr>
                    <td colSpan={columns.length}>
                      <ThreatForm
                        threatModelId={threatModelId}
                        initial={threat}
                        mitigations={own}
                        elements={elements}
                        onSubmit={async (input) => {
                          // The edit form only ever builds an update (ThreatsSection casts the create side alike).
                          await update.mutateAsync({ id: threat.id, input: input as ThreatUpdateInput });
                          setEditingId(null);
                          onRowSaved?.(threat.id);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    </td>
                  </tr>
                )}
                {open && (
                  <tr id={panelId}>
                    <td colSpan={columns.length}>
                      {threat.description && <p>{threat.description}</p>}
                      <MitigationList threatId={threat.id} threatModelId={threatModelId} mitigations={own} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {deleting && (
        <ConfirmDialog
          title="Delete threat"
          message={
            (deletingCount > 0
              ? `Delete threat "${deleting.title}"? Its ${deletingCount} mitigation(s) will be deleted too.`
              : `Delete threat "${deleting.title}"?`) +
            // A deleted generated threat is not remembered: the next run creates it again (spec FR-016a).
            (deleting.origin === 'rule' ? ` ${COMES_BACK}` : '')
          }
          confirmLabel="Delete"
          onConfirm={() => void onDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
