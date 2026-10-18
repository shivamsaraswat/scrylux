import { ELEMENT_FLAGS, ElementInputBase, TYPE_LABELS, flagLabel, type ElementRecord, type ElementType } from '@scrylux/core';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { FormField } from '../components/FormField.js';
import { useDiagramEditor } from './DiagramEditorProvider.js';
import { FlagRadioGroup } from './FlagRadioGroup.js';
import { descendantsOf, setBoundaryAction } from './membership.js';
import type { DiagramAction } from './operations.js';
import { buildProperties, carryFlags, flagState, splitProperties, withFlag, type FlagState } from './properties-model.js';
import { TagsEditor } from './TagsEditor.js';


// A node may become another node type; a data flow and a trust boundary never change type (FR-006).
const NODE_TYPES: readonly ElementType[] = ['external_entity', 'process', 'data_store'];

// The properties of the one selected element (FR-013). Every change is one action, saved as it is made.
export function PropertiesPanel() {
  const editor = useDiagramEditor();
  const element = editor.selectedIds.length === 1 ? editor.elements?.find((e) => e.id === editor.selectedIds[0]) : undefined;
  return (
    <aside aria-label="Properties" className="diagram-panel">
      {element ? <ElementProperties key={element.id} element={element} /> : <p className="muted">Select an element to see its properties</p>}
    </aside>
  );
}

interface Question {
  title: string;
  message: string;
  confirmLabel: string;
  action: DiagramAction;
}

function ElementProperties({ element }: { element: ElementRecord }) {
  const editor = useDiagramEditor();
  const byId = new Map((editor.elements ?? []).map((e) => [e.id, e]));
  const [question, setQuestion] = useState<Question | null>(null);
  const current = splitProperties(element.type, element.properties);

  // Saves a change, or first asks when it would also remove what is stored outside the vocabulary: those
  // are removed by the first change to the properties, and the user is told before that happens.
  function save(action: DiagramAction): void {
    if (current.other.length === 0) {
      editor.apply(action);
      return;
    }
    setQuestion({
      title: 'Remove other stored properties?',
      message: `This element has properties the editor does not use: ${current.other.join(', ')}. Saving this change removes them.`,
      confirmLabel: 'Remove and save',
      action,
    });
  }

  function changeProperties(tags: string[], flags: Record<string, boolean>, label: string): void {
    save({ label, ops: [{ op: 'update', id: element.id, changes: { properties: buildProperties({ tags, flags }) } }] });
  }

  function changeType(next: ElementType): void {
    const { kept, lost } = carryFlags(current.flags, next);
    const hasProperties = Object.keys(element.properties).length > 0;
    const action: DiagramAction = {
      label: `Change ${element.name} to ${TYPE_LABELS[next].toLowerCase()}`,
      ops: [
        {
          op: 'update',
          id: element.id,
          changes: { type: next, ...(hasProperties ? { properties: buildProperties({ tags: current.tags, flags: kept }) } : {}) },
        },
      ],
    };
    if (lost.length === 0 && current.other.length === 0) {
      editor.apply(action);
      return;
    }
    const removed = lost.map((flag) => `${flagLabel(flag)} (${current.flags[flag] ? 'yes' : 'no'})`);
    setQuestion({
      title: 'Change type',
      message:
        `Changing to ${TYPE_LABELS[next].toLowerCase()} removes` +
        (removed.length > 0 ? ` these flags, which do not apply to it: ${removed.join(', ')}.` : '') +
        (current.other.length > 0 ? ` It also removes properties the editor does not use: ${current.other.join(', ')}.` : ''),
      confirmLabel: 'Change type',
      action,
    });
  }

  return (
    <div>
      <p className="muted">{TYPE_LABELS[element.type]}</p>
      <NameField element={element} />
      {NODE_TYPES.includes(element.type) && (
        <FormField id="diagram-element-type" label="Type">
          {(control) => (
            <select {...control} value={element.type} onChange={(event) => changeType(event.target.value as ElementType)}>
              {NODE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          )}
        </FormField>
      )}
      {element.type !== 'data_flow' && <BoundaryField element={element} />}
      {element.type === 'data_flow' && (
        <dl>
          <dt>Source</dt>
          <dd>{byId.get(element.source_element_id ?? '')?.name ?? '—'}</dd>
          <dt>Target</dt>
          <dd>{byId.get(element.target_element_id ?? '')?.name ?? '—'}</dd>
        </dl>
      )}
      {ELEMENT_FLAGS[element.type].length > 0 && (
        <div className="diagram-flags">
          {ELEMENT_FLAGS[element.type].map((flag) => (
            <FlagRadioGroup
              key={flag}
              flag={flag}
              value={flagState(current.flags[flag])}
              onChange={(state: FlagState) =>
                changeProperties(current.tags, withFlag(current.flags, flag, state), `Set ${flagLabel(flag)} on ${element.name}`)
              }
            />
          ))}
        </div>
      )}
      <TagsEditor
        type={element.type}
        tags={current.tags}
        onChange={(tags) => changeProperties(tags, current.flags, `Change the technology tags of ${element.name}`)}
      />
      {current.other.length > 0 && (
        <section aria-label="Other stored properties" className="diagram-other">
          <h3>Other stored properties</h3>
          <ul>
            {current.other.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p className="muted">The editor does not use these. They are removed the next time properties are changed.</p>
        </section>
      )}
      <button type="button" className="danger" onClick={() => editor.requestDelete(element.id)}>
        Delete element
      </button>
      {question && (
        <ConfirmDialog
          title={question.title}
          message={question.message}
          confirmLabel={question.confirmLabel}
          onConfirm={() => {
            editor.apply(question.action);
            setQuestion(null);
          }}
          onCancel={() => setQuestion(null)}
        />
      )}
    </div>
  );
}

// The boundary the element is in, as a choice: the keyboard's way to do what dragging does (FR-012). A
// boundary cannot be put inside itself or inside a boundary it holds, so those are not offered.
function BoundaryField({ element }: { element: ElementRecord }) {
  const editor = useDiagramEditor();
  const elements = editor.elements ?? [];
  const own = descendantsOf(elements, element.id);
  const options = elements.filter((candidate) => candidate.type === 'trust_boundary' && !own.has(candidate.id));
  const current = options.some((option) => option.id === element.parent_boundary_id) ? (element.parent_boundary_id ?? '') : '';
  return (
    <FormField id="diagram-element-boundary" label="Trust boundary">
      {(control) => (
        <select
          {...control}
          value={current}
          onChange={(event) => {
            const action = setBoundaryAction(elements, element.id, event.target.value === '' ? null : event.target.value);
            if (action) editor.apply(action);
          }}
        >
          <option value="">None</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      )}
    </FormField>
  );
}

// The name is saved when the field is left or Enter is pressed, never on each key. A name the shared
// rules refuse is not saved, and says why next to the field (FR-014).
//
// What the user has typed, and what they last saved, are each remembered together with the name they
// started from. If the name changes from outside the field (an undo, say), they no longer match it and
// the field shows the element's own name again, with no effect needed to copy it over.
function NameField({ element }: { element: ElementRecord }) {
  const editor = useDiagramEditor();
  const [typed, setTyped] = useState<{ base: string; text: string } | null>(null);
  const [saved, setSaved] = useState<{ base: string; text: string } | null>(null);
  const [problem, setProblem] = useState<{ base: string; message: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const text = typed?.base === element.name ? typed.text : element.name;
  const lastSaved = saved?.base === element.name ? saved.text : element.name;
  const error = problem?.base === element.name ? problem.message : null;

  useEffect(() => {
    if (editor.focusNameFor !== element.id) return;
    input.current?.focus();
    input.current?.select();
    editor.clearNameFocus();
  }, [editor, element.id]);

  function commit(): void {
    if (text.trim() === lastSaved) {
      setProblem(null);
      return;
    }
    const parsed = ElementInputBase.shape.name.safeParse(text);
    if (!parsed.success) {
      setProblem({ base: element.name, message: parsed.error.issues[0]?.message ?? 'is not valid' });
      return;
    }
    setProblem(null);
    setSaved({ base: element.name, text: parsed.data });
    setTyped({ base: element.name, text: parsed.data });
    editor.apply({ label: `Rename ${element.name}`, ops: [{ op: 'update', id: element.id, changes: { name: parsed.data } }] });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    commit();
  }

  return (
    <FormField id="diagram-element-name" label="Name" error={error}>
      {(control) => (
        <input
          {...control}
          ref={input}
          type="text"
          value={text}
          onChange={(event) => setTyped({ base: element.name, text: event.target.value })}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      )}
    </FormField>
  );
}
