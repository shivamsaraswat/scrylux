import { DEFAULT_BOUNDARY_SIZE, MAX_ELEMENTS, NODE_SIZE, absoluteRects, freeSpotNear, resolveLayout } from '@scrylux/core';
import { useReactFlow, useStore } from '@xyflow/react';
import { useState } from 'react';
import { AddFlowDialog } from './AddFlowDialog.js';
import { FIT_VIEW } from './Canvas.js';
import { useDiagramEditor } from './DiagramEditorProvider.js';
import { useUndoShortcuts } from './keyboard.js';
import { newElementId } from './operations.js';
import { SaveStatus } from './SaveStatus.js';

type AddableNode = keyof typeof NODE_SIZE | 'trust_boundary';

const ADD_BUTTONS: readonly { type: AddableNode; label: string; name: string }[] = [
  { type: 'external_entity', label: 'Add external entity', name: 'New external entity' },
  { type: 'process', label: 'Add process', name: 'New process' },
  { type: 'data_store', label: 'Add data store', name: 'New data store' },
  { type: 'trust_boundary', label: 'Add trust boundary', name: 'New trust boundary' },
];

const LIMIT_MESSAGE_ID = 'diagram-limit-message';

// "Move API" is undone by "Undo move API".
const described = (verb: string, label: string | null): string | undefined =>
  label === null ? undefined : `${verb} ${label.charAt(0).toLowerCase()}${label.slice(1)}`;

// The tools above the canvas: add an element of each kind, fit the diagram in view, and a notice when the
// editor refused something. A new element appears near the middle of what the user is looking at, in free
// space, selected, with the cursor in its name (contracts/ui.md).
export function Toolbar() {
  const editor = useDiagramEditor();
  const { fitView, getViewport } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const atLimit = (editor.elements?.length ?? 0) >= MAX_ELEMENTS;
  const [addingFlow, setAddingFlow] = useState(false);
  useUndoShortcuts(editor);
  const ends = (editor.elements ?? []).filter((element) => ['external_entity', 'process', 'data_store'].includes(element.type)).length;

  function add(type: AddableNode, name: string, label: string): void {
    const elements = editor.elements ?? [];
    const occupied = [...absoluteRects(elements, resolveLayout(elements)).values()];
    const view = getViewport();
    const center = { x: (width / 2 - view.x) / view.zoom, y: (height / 2 - view.y) / view.zoom };
    const size = type === 'trust_boundary' ? DEFAULT_BOUNDARY_SIZE : NODE_SIZE[type];
    const spot = freeSpotNear(center, occupied, size);
    const id = newElementId();
    const place = { x: Math.round(spot.x), y: Math.round(spot.y) };
    editor.setNotice(null);
    editor.apply({
      label,
      ops: [{ op: 'create', element: { id, type, name, layout: type === 'trust_boundary' ? { ...place, ...size } : place } }],
    });
    editor.select([id]);
    editor.requestNameFocus(id);
  }

  return (
    <div role="toolbar" aria-label="Diagram tools" className="diagram-toolbar">
      {ADD_BUTTONS.map(({ type, label, name }) => (
        <button
          key={type}
          type="button"
          disabled={atLimit}
          aria-describedby={atLimit ? LIMIT_MESSAGE_ID : undefined}
          onClick={() => add(type, name, label)}
        >
          {label}
        </button>
      ))}
      <button type="button" disabled={atLimit || ends < 2} onClick={() => setAddingFlow(true)}>
        Add data flow
      </button>
      <button type="button" disabled={editor.undoLabel === null} title={described('Undo', editor.undoLabel)} onClick={editor.undo}>
        Undo
      </button>
      <button type="button" disabled={editor.redoLabel === null} title={described('Redo', editor.redoLabel)} onClick={editor.redo}>
        Redo
      </button>
      <button type="button" onClick={() => void fitView(FIT_VIEW)}>
        Fit to view
      </button>
      <SaveStatus />
      {addingFlow && <AddFlowDialog onClose={() => setAddingFlow(false)} />}
      {atLimit && (
        <p id={LIMIT_MESSAGE_ID} className="muted">
          This threat model has reached the limit of {MAX_ELEMENTS.toLocaleString('en-US')} elements.
        </p>
      )}
      {editor.notice && (
        <p role="alert" className="diagram-notice">
          {editor.notice}
        </p>
      )}
    </div>
  );
}
