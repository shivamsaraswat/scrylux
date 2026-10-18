import type { ElementBatchOperationInput, ElementRecord } from '@scrylux/core';

// What one user action does to the diagram, as the batch operations that save it (research #5, #8, #9).
// The same operations are replayed locally, so the screen shows an action the moment it is made and the
// server's answer later only confirms it.

type CreateOperation = Extract<ElementBatchOperationInput, { op: 'create' }>;

// The editor always chooses the id of what it creates, so an undone delete can bring the same id back.
export type BatchOp =
  | { op: 'create'; element: CreateOperation['element'] & { id: string } }
  | Exclude<ElementBatchOperationInput, { op: 'create' }>;

// One user action: what the screen says about it, and the operations that save it, all or none.
export interface DiagramAction {
  label: string;
  ops: BatchOp[];
}

export const newElementId = (): string => crypto.randomUUID();

interface Position {
  x: number;
  y: number;
}

function positionOf(layout: unknown): Position | null {
  if (typeof layout !== 'object' || layout === null) return null;
  const { x, y } = layout as Record<string, unknown>;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
}

function create(threatModelId: string, element: CreateOperation['element'] & { id: string }): ElementRecord {
  const now = new Date().toISOString();
  return {
    id: element.id,
    threat_model_id: threatModelId,
    type: element.type,
    name: element.name,
    properties: element.properties ?? {},
    layout: element.layout ?? null,
    source_element_id: element.source_element_id ?? null,
    target_element_id: element.target_element_id ?? null,
    parent_boundary_id: element.parent_boundary_id ?? null,
    created_at: now,
    updated_at: now,
  };
}

// What the server does when an element goes: its data flows go with it, and the members of a trust
// boundary move up to the boundary's own parent, keeping their place on the diagram (data-model.md
// "Deleting a trust boundary", FR-021, FR-022).
function remove(elements: ElementRecord[], id: string): ElementRecord[] {
  const gone = elements.find((element) => element.id === id);
  if (!gone) return elements;
  const offset = gone.type === 'trust_boundary' ? positionOf(gone.layout) : null;
  return elements
    .filter((element) => element.id !== id && element.source_element_id !== id && element.target_element_id !== id)
    .map((element) => {
      if (gone.type !== 'trust_boundary' || element.parent_boundary_id !== id) return element;
      const here = positionOf(element.layout);
      const layout =
        here && offset ? { ...(element.layout as Record<string, unknown>), x: here.x + offset.x, y: here.y + offset.y } : element.layout;
      return { ...element, parent_boundary_id: gone.parent_boundary_id, layout };
    });
}

// Replays operations on a list of elements. An operation on an element that is not there does nothing,
// and a create of an id that is there replaces it, so replaying an action the server has already stored
// changes nothing.
export function applyOps(threatModelId: string, elements: readonly ElementRecord[], ops: readonly BatchOp[]): ElementRecord[] {
  let result = [...elements];
  for (const operation of ops) {
    if (operation.op === 'create') {
      const record = create(threatModelId, operation.element);
      const at = result.findIndex((element) => element.id === record.id);
      if (at === -1) result.push(record);
      else result[at] = record;
    } else if (operation.op === 'update') {
      result = result.map((element) =>
        element.id === operation.id ? ({ ...element, ...operation.changes, updated_at: new Date().toISOString() }) : element,
      );
    } else {
      result = remove(result, operation.id);
    }
  }
  return result;
}

export function applyActions(
  threatModelId: string,
  elements: readonly ElementRecord[],
  actions: readonly DiagramAction[],
): ElementRecord[] {
  return actions.reduce((current, action) => applyOps(threatModelId, current, action.ops), [...elements]);
}

// ---- undo ----

// An element as the operation that would create it again, with the same id (FR-024b).
function recreate(record: ElementRecord): BatchOp {
  return {
    op: 'create',
    element: {
      id: record.id,
      type: record.type,
      name: record.name,
      properties: record.properties,
      layout: record.layout,
      source_element_id: record.source_element_id,
      target_element_id: record.target_element_id,
      parent_boundary_id: record.parent_boundary_id,
    },
  };
}

// The operations that take one operation back, given the elements as they were just before it.
function invertOne(elements: readonly ElementRecord[], operation: BatchOp): BatchOp[] {
  if (operation.op === 'create') {
    const existing = elements.find((element) => element.id === operation.element.id);
    return [existing ? recreate(existing) : { op: 'delete', id: operation.element.id }];
  }
  const before = elements.find((element) => element.id === operation.id);
  if (!before) return [];
  if (operation.op === 'update') {
    // Only what the update wrote is put back.
    const changes = Object.fromEntries(Object.keys(operation.changes).map((key) => [key, before[key as keyof ElementRecord]]));
    return [{ op: 'update', id: operation.id, changes }];
  }
  // A delete took more with it. The element comes back first, so what refers to it has something to refer to:
  // then the members of a trust boundary go back into it, where they were in its frame, and then its flows.
  const members = elements.filter((element) => before.type === 'trust_boundary' && element.parent_boundary_id === before.id);
  const flows = elements.filter((element) => element.source_element_id === before.id || element.target_element_id === before.id);
  return [
    recreate(before),
    ...members.map((member): BatchOp => ({ op: 'update', id: member.id, changes: { parent_boundary_id: member.parent_boundary_id, layout: member.layout } })),
    ...flows.map(recreate),
  ];
}

// The operations that undo an action: each operation's inverse, last first, each worked out from the elements
// as they were when that operation was made. `before` is the diagram as it was before the action (FR-024).
export function inverseOf(threatModelId: string, before: readonly ElementRecord[], ops: readonly BatchOp[]): BatchOp[] {
  let elements = [...before];
  const inverses: BatchOp[][] = [];
  for (const operation of ops) {
    inverses.push(invertOne(elements, operation));
    elements = applyOps(threatModelId, elements, [operation]);
  }
  return inverses.reverse().flat();
}
