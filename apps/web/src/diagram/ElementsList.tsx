import { TYPE_LABELS, type ElementRecord } from '@scrylux/core';
import { useDiagramEditor } from './DiagramEditorProvider.js';

const GROUP = { trust_boundary: 0, data_flow: 2 } as const;
const groupOf = (element: ElementRecord): number => GROUP[element.type as keyof typeof GROUP] ?? 1;

// Every element of the diagram as a plain list, for getting to any of them without a pointer (spec FR-025).
// Choosing one selects it and moves focus to it on the canvas, where the arrow keys then move it. Boundaries
// come first, then the nodes, then the flows, each group by name. An element with open threats says how many in its
// button, so a keyboard or screen-reader user gets the count with the element (spec FR-017).
export function ElementsList() {
  const { elements = [], selectedIds, select, openThreats } = useDiagramEditor();
  const sorted = [...elements].sort((a, b) => groupOf(a) - groupOf(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  function choose(id: string): void {
    select([id]);
    // React Flow draws every node and flow with the element's id on it. Focus follows once it is drawn selected.
    document.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
  }

  return (
    <nav aria-label="Elements" className="diagram-elements">
      <h2>Elements</h2>
      {sorted.length === 0 ? (
        <p className="muted">No elements yet</p>
      ) : (
        <ul>
          {sorted.map((element) => (
            <li key={element.id}>
              <button type="button" aria-current={selectedIds.includes(element.id) ? 'true' : undefined} onClick={() => choose(element.id)}>
                {TYPE_LABELS[element.type]}: {element.name}
                {(openThreats.get(element.id) ?? 0) > 0 && ` · ${openThreats.get(element.id)} open`}
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
