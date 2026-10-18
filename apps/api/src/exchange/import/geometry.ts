import { COORDINATE_LIMIT, MAX_BOUNDARY_SIZE, MIN_BOUNDARY_SIZE, type BoundaryLayout, type NodeLayout } from '@scrylux/core';

// Positions from another tool's file, held to the limits Scrylux's own diagram has (FR-008a): what cannot be held is left
// for the canvas to place, or enlarged to the smallest size allowed, and the caller adds a note.

export interface Placement<L> {
  layout: L | null;
  // What was done to fit, for the note; null when the file's position was used as it is, or there was none.
  adjusted: 'unplaced' | 'enlarged' | null;
}

const inRange = (value: number): boolean => Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;

interface Point {
  x: number;
  y: number;
}
interface Size {
  width: number;
  height: number;
}

export function placeNode(position: Point | null | undefined): Placement<NodeLayout> {
  if (position === null || position === undefined) return { layout: null, adjusted: null };
  if (!inRange(position.x) || !inRange(position.y)) return { layout: null, adjusted: 'unplaced' };
  return { layout: { x: position.x, y: position.y }, adjusted: null };
}

// A trust boundary needs a size as well: one smaller than the least Scrylux draws is enlarged to it.
export function placeBoundary(position: Point | null | undefined, size: Size | null | undefined): Placement<BoundaryLayout> {
  if (position === null || position === undefined) return { layout: null, adjusted: null };
  if (!inRange(position.x) || !inRange(position.y) || size === null || size === undefined) return { layout: null, adjusted: 'unplaced' };
  const { width, height } = size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width > MAX_BOUNDARY_SIZE || height > MAX_BOUNDARY_SIZE) {
    return { layout: null, adjusted: 'unplaced' };
  }
  const enlarged = width < MIN_BOUNDARY_SIZE || height < MIN_BOUNDARY_SIZE;
  return {
    layout: { x: position.x, y: position.y, width: Math.max(width, MIN_BOUNDARY_SIZE), height: Math.max(height, MIN_BOUNDARY_SIZE) },
    adjusted: enlarged ? 'enlarged' : null,
  };
}

export interface Rect extends Point, Size {}

const area = (rect: Rect): number => rect.width * rect.height;

const holdsPoint = (outer: Rect, point: Point): boolean =>
  point.x >= outer.x && point.x <= outer.x + outer.width && point.y >= outer.y && point.y <= outer.y + outer.height;

const holdsRect = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

// Threat Dragon's cells do not say what they are inside: a trust boundary box is only a rectangle that happens to be
// drawn around other cells. So the nesting is worked out from where things are drawn (contracts/threat-dragon-mapping.md):
//
//  - a node is in the smallest box that holds its centre;
//  - a box is in the smallest other box that holds all of it;
//  - where areas are equal, the box earlier in the file wins.
//
// A box is only a candidate parent of another when it is larger, or equal and earlier in the file, so two boxes of the
// same rectangle nest one inside the other and never into a cycle: the result is always a forest.
export function assignBoxes(
  boxes: readonly { id: string; rect: Rect }[],
  nodes: readonly { id: string; point: Point }[],
): { boxParent: Map<string, string | null>; nodeParent: Map<string, string | null> } {
  const smallest = (candidates: readonly { id: string; rect: Rect }[]): string | null => {
    let best: { id: string; rect: Rect } | null = null;
    for (const candidate of candidates) if (best === null || area(candidate.rect) < area(best.rect)) best = candidate;
    return best?.id ?? null;
  };

  const boxParent = new Map<string, string | null>();
  boxes.forEach((inner, at) => {
    const candidates = boxes.filter(
      (outer, index) => index !== at && holdsRect(outer.rect, inner.rect) && (area(outer.rect) > area(inner.rect) || (area(outer.rect) === area(inner.rect) && index < at)),
    );
    boxParent.set(inner.id, smallest(candidates));
  });

  const nodeParent = new Map<string, string | null>();
  for (const { id, point } of nodes) nodeParent.set(id, smallest(boxes.filter((outer) => holdsPoint(outer.rect, point))));
  return { boxParent, nodeParent };
}

// A position in its parent's frame: Scrylux stores a member's position relative to its trust boundary.
export function relativeTo(position: Point, parent: Point | null): Point {
  return parent === null ? { x: position.x, y: position.y } : { x: position.x - parent.x, y: position.y - parent.y };
}
