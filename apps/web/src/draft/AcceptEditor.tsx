import { ELEMENT_FLAGS, flagLabel, type DraftRecord, type EditRef, type ElementRecord, type ItemEdits } from '@scrylux/core';
import { useState } from 'react';
import type { DraftItem } from './draft-items.js';

// The form in which an item is accepted with changes (Phase 3 Milestone 5, contracts/ui.md item 5, FR-013): the model's values filled in, the fields the kind
// of item takes, and a request that carries only what was changed. The rationale and the citations are shown and cannot be edited. Whatever the API refuses
// is shown beside the form as text. Nothing here is sent until Accept; Cancel sends nothing.

const NODE_TYPES = ['process', 'data_store', 'external_entity'];

const toRef = (value: string): EditRef => (value.startsWith('item:') ? { item: value.slice('item:'.length) } : { element: value.slice('element:'.length) });
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value) => b.includes(value));

interface Choice {
  value: string;
  label: string;
}

export function AcceptEditor({
  draft,
  item,
  elements,
  pending,
  error,
  onAccept,
  onCancel,
}: {
  draft: DraftRecord;
  item: DraftItem;
  /** The elements the threat model has now: an end or a boundary can be one of them. */
  elements: readonly ElementRecord[];
  pending: boolean;
  error: string | null;
  onAccept: (edits: ItemEdits | undefined) => void;
  onCancel: () => void;
}) {
  const element = draft.elements.find((candidate) => candidate.id === item.id);
  const asset = draft.assets.find((candidate) => candidate.id === item.id);
  const assumption = draft.assumptions.find((candidate) => candidate.id === item.id);
  const isFlow = element?.type === 'data_flow';
  const takesBoundary = element !== undefined && !isFlow;

  const choices = (types: readonly string[]): Choice[] => [
    ...draft.elements.filter((candidate) => candidate.id !== item.id && types.includes(candidate.type)).map((candidate) => ({ value: `item:${candidate.id}`, label: `${candidate.name} (in this draft)` })),
    ...elements.filter((candidate) => types.includes(candidate.type)).map((candidate) => ({ value: `element:${candidate.id}`, label: `${candidate.name} (in the threat model)` })),
  ];
  const nodes = choices(NODE_TYPES);
  const boundaries = choices(['trust_boundary']);
  const initial = {
    name: element?.name ?? asset?.name ?? '',
    boundary: element?.boundary_id == null ? '' : `item:${element.boundary_id}`,
    source: element?.source_id == null ? '' : `item:${element.source_id}`,
    target: element?.target_id == null ? '' : `item:${element.target_id}`,
    description: asset?.description ?? '',
    statement: assumption?.statement ?? '',
    holders: (asset?.held_by ?? []).map((id) => `item:${id}`),
    flags: Object.fromEntries((element?.flags ?? []).map((flag) => [flag.flag, String(flag.value)])) as Record<string, string>,
  };

  const [name, setName] = useState(initial.name);
  const [boundary, setBoundary] = useState(initial.boundary);
  const [source, setSource] = useState(initial.source);
  const [target, setTarget] = useState(initial.target);
  const [description, setDescription] = useState(initial.description);
  const [statement, setStatement] = useState(initial.statement);
  const [holders, setHolders] = useState<string[]>(initial.holders);
  const [flags, setFlags] = useState<Record<string, string>>(initial.flags);

  /** Only what differs from what the model proposed. */
  function changes(): ItemEdits | undefined {
    const edits: ItemEdits = {};
    if (name !== initial.name) edits.name = name;
    const changedFlags = Object.fromEntries(
      (element === undefined ? [] : ELEMENT_FLAGS[element.type])
        .filter((flag) => (flags[flag] ?? '') !== (initial.flags[flag] ?? ''))
        .map((flag) => [flag, flags[flag] === undefined || flags[flag] === '' ? null : flags[flag] === 'true']),
    );
    if (Object.keys(changedFlags).length > 0) edits.flags = changedFlags;
    if (takesBoundary && boundary !== initial.boundary) edits.boundary = boundary === '' ? null : toRef(boundary);
    if (isFlow && source !== initial.source && source !== '') edits.source = toRef(source);
    if (isFlow && target !== initial.target && target !== '') edits.target = toRef(target);
    if (asset !== undefined && description !== initial.description) edits.description = description;
    if (assumption !== undefined && statement !== initial.statement) edits.statement = statement;
    if (asset !== undefined && !sameSet(holders, initial.holders)) edits.holders = holders.map(toRef);
    return Object.keys(edits).length === 0 ? undefined : edits;
  }

  const select = (label: string, value: string, set: (next: string) => void, options: readonly Choice[], none: string | null) => (
    <p>
      <label>
        {label}{' '}
        <select value={value} onChange={(event) => set(event.target.value)}>
          {none !== null && <option value="">{none}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </p>
  );

  return (
    <form
      aria-label="Accept with changes"
      className="draft-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onAccept(changes());
      }}
    >
      <h4>
        Accept {item.typeLabel}: {item.title}
      </h4>
      {element !== undefined || asset !== undefined ? (
        <p>
          <label>
            Name <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
        </p>
      ) : null}
      {takesBoundary && select('Boundary', boundary, setBoundary, boundaries, 'None')}
      {isFlow && select('From', source, setSource, nodes, null)}
      {isFlow && select('To', target, setTarget, nodes, null)}
      {element !== undefined &&
        ELEMENT_FLAGS[element.type].map((flag) => {
          const proposed = initial.flags[flag];
          return (
            <p key={flag}>
              <label>
                {flagLabel(flag)}{' '}
                <select value={flags[flag] ?? ''} onChange={(event) => setFlags((now) => ({ ...now, [flag]: event.target.value }))}>
                  <option value="">Not assessed</option>
                  <option value="true">{proposed === 'true' ? 'Yes (proposed)' : 'Yes'}</option>
                  <option value="false">{proposed === 'false' ? 'No (proposed)' : 'No'}</option>
                </select>
              </label>
            </p>
          );
        })}
      {asset !== undefined && (
        <>
          <p>
            <label>
              Description <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
          </p>
          <fieldset>
            <legend>Held by</legend>
            {nodes.map((node) => (
              <p key={node.value}>
                <label>
                  <input
                    type="checkbox"
                    checked={holders.includes(node.value)}
                    onChange={() => setHolders((now) => (now.includes(node.value) ? now.filter((value) => value !== node.value) : [...now, node.value]))}
                  />{' '}
                  {node.label}
                </label>
              </p>
            ))}
          </fieldset>
        </>
      )}
      {assumption !== undefined && (
        <p>
          <label>
            Statement <textarea value={statement} onChange={(event) => setStatement(event.target.value)} />
          </label>
        </p>
      )}
      <h4>Why it was proposed</h4>
      <p>{item.rationale}</p>
      <p className="muted">The rationale and the citations cannot be edited.</p>
      {error !== null && <p role="alert">{error}</p>}
      <p>
        <button type="submit" disabled={pending}>
          Accept
        </button>{' '}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}
