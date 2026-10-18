import { useQueryClient } from '@tanstack/react-query';
import { TYPE_LABELS, type ThreatRecord } from '@scrylux/core';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { keys, useCreateThreat, useElements, useModelMitigations, useThreats } from '../api/queries.js';
import { LoadError } from '../components/LoadError.js';
import { focusNeighbour, leftMessage } from '../components/row-focus.js';
import { ThreatForm } from '../components/ThreatForm.js';
import { ThreatTable } from '../components/ThreatTable.js';
import { useDiagramEditor } from './DiagramEditorProvider.js';

// The threats of the one element selected on the canvas or in the elements list, below the diagram
// (contracts/web-ui.md §4; spec FR-011 to FR-014). It is the threat table of the Threats tab, so a threat is
// changed, edited, deleted and given mitigations exactly as there. It sits outside the canvas, so the canvas's
// Delete key and the undo shortcuts never act while the user types here, and nothing it does touches the
// diagram's selection, viewport or undo history (FR-012). A trust boundary shows its own threats only (FR-014).
export function ElementThreats() {
  const { threatModelId, elements = [], selectedIds } = useDiagramEditor();
  const threats = useThreats(threatModelId);
  const mitigations = useModelMitigations(threatModelId);
  const modelElements = useElements(threatModelId);
  const create = useCreateThreat(threatModelId);
  // The element the add form is open for, so choosing another element closes it.
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const client = useQueryClient();
  // How many threats have left this element's list in a row, with nothing else saved in between. It belongs to the
  // element it was counted for, so selecting another element starts again (T069).
  const [left, setLeft] = useState({ element: '', departures: 0 });
  const addButton = useRef<HTMLButtonElement>(null);

  const element = selectedIds.length === 1 ? elements.find((candidate) => candidate.id === selectedIds[0]) : undefined;
  const failed = [threats, mitigations].filter((query) => query.isError);

  // A threat changed here may no longer be this element's (a manual threat linked to another element). It leaves
  // the list, so focus goes to the row after it, or before it, or to the add button, and the panel says why.
  function rowSaved(id: string, own: readonly ThreatRecord[]): void {
    const latest = client.getQueryData<ThreatRecord[]>(keys.threats(threatModelId));
    if (!latest || !element) return;
    if (latest.find((threat) => threat.id === id)?.element_id === element.id) {
      setLeft({ element: element.id, departures: 0 });
      return;
    }
    setLeft((previous) => ({ element: element.id, departures: previous.element === element.id ? previous.departures + 1 : 1 }));
    if (!focusNeighbour(own.map((threat) => threat.id), id)) addButton.current?.focus();
  }

  let content;
  if (selectedIds.length > 1) {
    content = <p className="muted">Select a single element to see its threats.</p>;
  } else if (!element) {
    content = <p className="muted">Select an element on the diagram or in the elements list to see its threats.</p>;
  } else if (failed.length > 0) {
    content = <LoadError error={failed[0]?.error} onRetry={() => failed.forEach((query) => void query.refetch())} />;
  } else if (!threats.data || !mitigations.data) {
    content = <p>Loading threats…</p>;
  } else {
    const own = threats.data.filter((threat) => threat.element_id === element.id);
    content = (
      <>
        <h2>
          Threats of {TYPE_LABELS[element.type]} {element.name}
        </h2>
        <p>
          <Link to={`/threat-models/${threatModelId}?element=${element.id}`}>Open in the threat list</Link>
        </p>
        {addingFor === element.id ? (
          <ThreatForm
            key={element.id}
            threatModelId={threatModelId}
            elements={modelElements.data ?? elements}
            presetElementId={element.id}
            onSubmit={async (input) => {
              await create.mutateAsync(input as Parameters<typeof create.mutateAsync>[0]);
              setAddingFor(null);
            }}
            onCancel={() => setAddingFor(null)}
          />
        ) : (
          <button ref={addButton} type="button" className="primary" onClick={() => setAddingFor(element.id)}>
            Add threat for {element.name}
          </button>
        )}
        <p role="status" className="muted">
          {leftMessage(element && left.element === element.id ? left.departures : 0)}
        </p>
        {own.length === 0 ? (
          <p>{element.name} has no threats yet.</p>
        ) : (
          <ThreatTable
            threatModelId={threatModelId}
            threats={own}
            mitigations={mitigations.data}
            elements={modelElements.data ?? elements}
            showElement={false}
            onRowSaved={(id) => rowSaved(id, own)}
          />
        )}
      </>
    );
  }

  return (
    <section aria-label="Threats of the selected element" className="element-threats">
      {content}
    </section>
  );
}
