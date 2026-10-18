import { absoluteRects, freeSpotInside, innermostOf, resolveLayout, sizeFor, type ElementRecord, type Rect, type Resolved } from '@scrylux/core';
import type { BatchOp, DiagramAction } from './operations.js';

// Which boundary an element belongs to follows where it is drawn (spec FR-008 to FR-011, research #13):
// an element wholly inside a boundary is a member of the innermost boundary that wholly contains it, and
// one that only overlaps an edge is a member of none. These functions take what the user just did (a drag
// or a resize) and say what to save: the moved elements, and every other element whose boundary changes
// because of it. All of it is one action, so it is stored together or not at all.

export const SELF_CONTAINMENT_MESSAGE = "A trust boundary can't contain itself.";

export type MembershipResult =
  | { kind: 'none' }
  | { kind: 'changes'; action: DiagramAction }
  | { kind: 'refused'; message: string };

interface Point {
  x: number;
  y: number;
}

const round = (value: number): number => Math.round(value);

// `id` itself and everything inside it, at any depth.
export function descendantsOf(elements: readonly ElementRecord[], id: string): Set<string> {
  const found = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const element of elements) {
      if (element.parent_boundary_id !== null && found.has(element.parent_boundary_id) && !found.has(element.id)) {
        found.add(element.id);
        grew = true;
      }
    }
  }
  return found;
}

// The layout to store for an element drawn at `rect`, relative to its parent's corner.
function layoutOf(element: ElementRecord, rect: Rect, parent: Rect | null): Record<string, number> {
  const x = round(rect.x - (parent?.x ?? 0));
  const y = round(rect.y - (parent?.y ?? 0));
  return element.type === 'trust_boundary' ? { x, y, width: round(rect.width), height: round(rect.height) } : { x, y };
}

interface Change {
  element: ElementRecord;
  parent: string | null;
  rect: Rect;
}

// Works out the new boundary of every candidate, given where everything is drawn after the user's change.
function decide(
  elements: readonly ElementRecord[],
  drawnBefore: ReadonlyMap<string, Rect>,
  drawnAfter: ReadonlyMap<string, Rect>,
  moved: ReadonlySet<string>,
  changedBoundaries: readonly string[],
  extra: ReadonlySet<string>,
  label: string,
): MembershipResult {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const boundaryRects = new Map([...drawnAfter].filter(([id]) => byId.get(id)?.type === 'trust_boundary'));
  const currentParent = (element: ElementRecord): string | null =>
    element.parent_boundary_id !== null && boundaryRects.has(element.parent_boundary_id) ? element.parent_boundary_id : null;

  // Who might change boundary: what was moved or resized, the members of a resized boundary, and any
  // element that a changed boundary now wholly covers.
  const candidates = new Set<string>([...moved, ...extra]);
  for (const boundaryId of changedBoundaries) {
    const box = drawnAfter.get(boundaryId);
    if (!box) continue;
    const inside = descendantsOf(elements, boundaryId);
    for (const [id, rect] of drawnAfter) {
      if (inside.has(id) || !byId.has(id)) continue;
      if (rect.x >= box.x && rect.y >= box.y && rect.x + rect.width <= box.x + box.width && rect.y + rect.height <= box.y + box.height) {
        candidates.add(id);
      }
    }
  }

  const changes: Change[] = [];
  for (const id of candidates) {
    const element = byId.get(id);
    const rect = drawnAfter.get(id);
    if (!element || !rect) continue;
    const own = element.type === 'trust_boundary' ? descendantsOf(elements, id) : new Set([id]);
    // A boundary dropped so that it lies inside one of its own descendants would contain itself.
    if (element.type === 'trust_boundary') {
      const geometric = innermostOf(rect, boundaryRects, new Set([id]));
      if (geometric !== null && own.has(geometric)) return { kind: 'refused', message: SELF_CONTAINMENT_MESSAGE };
    }
    changes.push({ element, parent: innermostOf(rect, boundaryRects, own), rect });
  }

  const ops: BatchOp[] = [];
  for (const { element, parent, rect } of changes) {
    const before = drawnBefore.get(element.id);
    const parentRect = parent === null ? null : (drawnAfter.get(parent) ?? null);
    const layout = layoutOf(element, rect, parentRect);
    const reparented = parent !== currentParent(element);
    const placedBefore = before ? layoutOf(element, before, currentParent(element) === null ? null : (drawnBefore.get(currentParent(element) ?? '') ?? null)) : null;
    const sameSpot = placedBefore !== null && JSON.stringify(placedBefore) === JSON.stringify(layout);
    if (!reparented && sameSpot) continue;
    ops.push({ op: 'update', id: element.id, changes: reparented ? { parent_boundary_id: parent, layout } : { layout } });
  }
  return ops.length === 0 ? { kind: 'none' } : { kind: 'changes', action: { label, ops } };
}

// The user dragged these elements to new places. `position` is where React Flow says each now is,
// relative to the boundary it was in when the drag began (or to the diagram when it was in none).
export function moveElements(
  elements: readonly ElementRecord[],
  movedElements: readonly { id: string; position: Point }[],
): MembershipResult {
  const resolved = resolveLayout(elements);
  const before = absoluteRects(elements, resolved);
  const byId = new Map(elements.map((element) => [element.id, element]));

  // Where each moved element is drawn once it has landed: its new place in its old boundary's frame.
  const after: Map<string, Resolved> = new Map(resolved);
  const moved = new Set<string>();
  const changedBoundaries: string[] = [];
  for (const { id, position } of movedElements) {
    const element = byId.get(id);
    const was = resolved.get(id);
    if (!element || !was) continue;
    const x = round(position.x);
    const y = round(position.y);
    // Letting go without having moved leaves the element as it was.
    if (x === round(was.x) && y === round(was.y)) continue;
    after.set(id, { ...was, x, y });
    moved.add(id);
    if (element.type === 'trust_boundary') changedBoundaries.push(id);
  }
  if (moved.size === 0) return { kind: 'none' };

  const [only] = moved;
  const label = moved.size === 1 ? `Move ${byId.get(only ?? '')?.name ?? 'element'}` : `Move ${moved.size} elements`;
  return decide(elements, before, absoluteRects(elements, after), moved, changedBoundaries, new Set(), label);
}

// The user resized a boundary. `rect` is its new place and size, in its parent's frame as React Flow gives
// it. What it holds stays where it is on the diagram, whichever corner moved.
export function resizeBoundary(
  elements: readonly ElementRecord[],
  id: string,
  rect: { x: number; y: number; width: number; height: number },
): MembershipResult {
  const resolved = resolveLayout(elements);
  const before = absoluteRects(elements, resolved);
  const boundary = elements.find((element) => element.id === id);
  const was = resolved.get(id);
  if (!boundary || !was) return { kind: 'none' };

  const after: Map<string, Resolved> = new Map(resolved);
  after.set(id, { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) });
  // Its direct members keep their place on the diagram, so their stored positions follow the corner.
  const members = new Set<string>();
  const corner = absoluteRects(elements, after).get(id);
  for (const element of elements) {
    if (element.parent_boundary_id !== id) continue;
    const place = before.get(element.id);
    const drawn = resolved.get(element.id);
    if (!place || !drawn || !corner) continue;
    after.set(element.id, { ...drawn, x: place.x - corner.x, y: place.y - corner.y });
    members.add(element.id);
  }

  return decide(elements, before, absoluteRects(elements, after), new Set([id]), [id], members, `Resize ${boundary.name}`);
}

// The user chose a boundary for an element in the properties panel. It is placed inside that boundary in
// free space, or, for None, taken out of its boundary and left where it is on the diagram.
export function setBoundaryAction(elements: readonly ElementRecord[], id: string, boundaryId: string | null): DiagramAction | null {
  const element = elements.find((candidate) => candidate.id === id);
  if (!element || element.type === 'data_flow') return null;
  const resolved = resolveLayout(elements);
  const rect = absoluteRects(elements, resolved).get(id);
  if (!rect) return null;

  if (boundaryId === null) {
    return { label: `Take ${element.name} out of its trust boundary`, ops: [{ op: 'update', id, changes: { parent_boundary_id: null, layout: layoutOf(element, rect, null) } }] };
  }
  const boundary = elements.find((candidate) => candidate.id === boundaryId && candidate.type === 'trust_boundary');
  // A boundary cannot be put inside itself or inside something it holds.
  if (!boundary || descendantsOf(elements, id).has(boundaryId)) return null;
  const size = sizeFor(element);
  const spot = freeSpotInside(elements, resolved, boundary, size, id);
  const layout = layoutOf(element, { ...spot, ...size }, { x: 0, y: 0, ...size });
  return { label: `Put ${element.name} in ${boundary.name}`, ops: [{ op: 'update', id, changes: { parent_boundary_id: boundaryId, layout } }] };
}
