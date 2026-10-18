import { TYPE_LABELS } from '@scrylux/core';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { connectionProblem, newFlowAction } from './connect.js';
import { useDiagramEditor } from './DiagramEditorProvider.js';

const ENDS = ['external_entity', 'process', 'data_store'];

// Creating a data flow without dragging (spec FR-025, US5): choose its source and its target from lists of
// the elements a flow can join. It is the keyboard's way to do what drawing a line does.
export function AddFlowDialog({ onClose }: { onClose: () => void }) {
  const editor = useDiagramEditor();
  const nodes = (editor.elements ?? []).filter((element) => ENDS.includes(element.type)).sort((a, b) => a.name.localeCompare(b.name));
  const [source, setSource] = useState(nodes[0]?.id ?? '');
  const [target, setTarget] = useState(nodes[1]?.id ?? nodes[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    // The first choice is where the keyboard starts, whether or not the browser moved focus there itself.
    element?.querySelector('select')?.focus();
    return () => {
      element?.close();
      opener?.focus();
    };
  }, []);

  function create(): void {
    const problem = connectionProblem(source, target, editor.elements ?? []);
    if (problem) {
      setError(problem);
      return;
    }
    const action = newFlowAction(source, target);
    editor.setNotice(null);
    editor.apply(action);
    const created = action.ops[0];
    if (created?.op === 'create') {
      editor.select([created.element.id]);
      editor.requestNameFocus(created.element.id);
    }
    onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  }

  const options = nodes.map((node) => (
    <option key={node.id} value={node.id}>
      {node.name} ({TYPE_LABELS[node.type].toLowerCase()})
    </option>
  ));

  return (
    <dialog ref={dialog} aria-labelledby="add-flow-title" onKeyDown={onKeyDown} onCancel={(event) => event.preventDefault()}>
      <h2 id="add-flow-title">Add data flow</h2>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="field">
        <label htmlFor="add-flow-source">Source</label>
        <select id="add-flow-source" value={source} onChange={(event) => setSource(event.target.value)}>
          {options}
        </select>
      </div>
      <div className="field">
        <label htmlFor="add-flow-target">Target</label>
        <select id="add-flow-target" value={target} onChange={(event) => setTarget(event.target.value)}>
          {options}
        </select>
      </div>
      <div className="actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" onClick={create}>
          Create
        </button>
      </div>
    </dialog>
  );
}
