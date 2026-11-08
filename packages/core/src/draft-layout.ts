import type { ElementType } from './enums.js';
import { NODE_SIZE } from './layout.js';
import { DEFAULT_BOUNDARY_SIZE } from './placement.js';

// Where the elements of a draft are drawn (Phase 3 Milestone 4, research #14, FR-060). The model proposes no positions and a draft's
// layout is not stored: this is a function of the items alone, so the same draft always looks the same. It is laid out from the
// inside out. The members of a trust boundary go on a grid of at most four columns, and the boundary is sized to hold them with the
// header and margin that the threat model's own diagram gives a boundary (placement.ts: 40, 20, and a gap of 24). Then the top level
// is laid out the same way. A data flow has no position: it is an edge between its endpoints.

const GAP = 24;
const BOUNDARY_HEADER = 40;
const BOUNDARY_MARGIN = 20;
const COLUMNS = 4;

/** The part of a draft's element that the layout needs. A `DraftElementRecord` satisfies it. */
export interface DraftLayoutItem {
  id: string;
  type: ElementType;
  boundary_id: string | null;
  source_id: string | null;
  target_id: string | null;
}

/** A node or a boundary, positioned relative to its parent boundary, or to the origin when it has none, as React Flow wants it. */
export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
}

export interface DraftEdge {
  id: string;
  source: string;
  target: string;
}

export interface DraftLayout {
  /** A boundary comes before the nodes it holds, as React Flow requires. */
  nodes: PlacedNode[];
  edges: DraftEdge[];
}

// A level reads processes first, then data stores, then external entities, then boundaries. Within a type, the order of the answer.
const RANK: Record<ElementType, number> = { process: 0, data_store: 1, external_entity: 2, trust_boundary: 3, data_flow: 4 };

interface Block {
  item: DraftLayoutItem;
  width: number;
  height: number;
  /** What the block holds, already positioned relative to their own parents. */
  below: PlacedNode[];
}

/** Lays out a draft. */
export function layoutDraft(items: readonly DraftLayoutItem[]): DraftLayout {
  const shapes = items.filter((item) => item.type !== 'data_flow');
  const ids = new Set(shapes.map((item) => item.id));
  const boundaries = new Set(shapes.filter((item) => item.type === 'trust_boundary').map((item) => item.id));

  // A member whose boundary is not in the draft goes to the top, and is not lost.
  const parentOf = (item: DraftLayoutItem): string | null =>
    item.boundary_id !== null && item.boundary_id !== item.id && ids.has(item.boundary_id) && boundaries.has(item.boundary_id) ? item.boundary_id : null;

  const childrenOf = new Map<string, DraftLayoutItem[]>();
  for (const item of shapes) {
    const parent = parentOf(item);
    if (parent !== null) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), item]);
  }

  // Every item is placed once. An item is claimed before anything below it is measured, so a cycle of boundaries, which a draft
  // never holds, cannot recurse for ever: the boundary reached again is already placed, and its place is the first one it got.
  const claimed = new Set<string>();

  function measure(item: DraftLayoutItem): Block {
    if (item.type !== 'trust_boundary') {
      const size = NODE_SIZE[item.type as keyof typeof NODE_SIZE];
      return { item, width: size.width, height: size.height, below: [] };
    }
    const members = (childrenOf.get(item.id) ?? []).filter((child) => !claimed.has(child.id));
    if (members.length === 0) return { item, width: DEFAULT_BOUNDARY_SIZE.width, height: DEFAULT_BOUNDARY_SIZE.height, below: [] };
    const inner = layoutLevel(members, item.id);
    // The members are laid out from the origin of their level; inside the boundary they start below its header and inside its margin.
    const below = inner.nodes.map((node) =>
      node.parentId === item.id ? { ...node, x: node.x + BOUNDARY_MARGIN, y: node.y + BOUNDARY_HEADER } : node,
    );
    return {
      item,
      width: Math.max(DEFAULT_BOUNDARY_SIZE.width, inner.width + 2 * BOUNDARY_MARGIN),
      height: Math.max(DEFAULT_BOUNDARY_SIZE.height, BOUNDARY_HEADER + inner.height + BOUNDARY_MARGIN),
      below,
    };
  }

  function layoutLevel(members: readonly DraftLayoutItem[], parentId: string | null): { nodes: PlacedNode[]; width: number; height: number } {
    const ordered = [...members].sort((a, b) => RANK[a.type] - RANK[b.type]);
    for (const member of ordered) claimed.add(member.id);
    const blocks = ordered.map(measure);

    const columns = Math.min(COLUMNS, blocks.length);
    const rows = Math.ceil(blocks.length / COLUMNS);
    const columnWidth = new Array<number>(columns).fill(0);
    const rowHeight = new Array<number>(rows).fill(0);
    blocks.forEach((block, index) => {
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      columnWidth[column] = Math.max(columnWidth[column] ?? 0, block.width);
      rowHeight[row] = Math.max(rowHeight[row] ?? 0, block.height);
    });
    const left = columnWidth.map((_, c) => columnWidth.slice(0, c).reduce((sum, w) => sum + w, 0) + c * GAP);
    const top = rowHeight.map((_, r) => rowHeight.slice(0, r).reduce((sum, h) => sum + h, 0) + r * GAP);

    const nodes: PlacedNode[] = [];
    blocks.forEach((block, index) => {
      nodes.push({
        id: block.item.id,
        x: left[index % COLUMNS] ?? 0,
        y: top[Math.floor(index / COLUMNS)] ?? 0,
        width: block.width,
        height: block.height,
        parentId,
      });
      nodes.push(...block.below);
    });
    return {
      nodes,
      width: columnWidth.reduce((sum, w) => sum + w, 0) + GAP * (columns - 1),
      height: rowHeight.reduce((sum, h) => sum + h, 0) + GAP * (rows - 1),
    };
  }

  // The top level is every item with no boundary in the draft. Whatever a cycle left unplaced is then placed at the top too.
  const roots = shapes.filter((item) => parentOf(item) === null);
  const top = roots.length === 0 ? { nodes: [] as PlacedNode[] } : layoutLevel(roots, null);
  const leftover = shapes.filter((item) => !claimed.has(item.id));
  const more = leftover.length === 0 ? { nodes: [] as PlacedNode[] } : layoutLevel(leftover, null);

  const placed = new Set([...top.nodes, ...more.nodes].map((node) => node.id));
  const edges: DraftEdge[] = items
    .filter((item) => item.type === 'data_flow' && item.source_id !== null && item.target_id !== null && placed.has(item.source_id) && placed.has(item.target_id))
    .map((item) => ({ id: item.id, source: item.source_id as string, target: item.target_id as string }));

  return { nodes: [...top.nodes, ...more.nodes], edges };
}
