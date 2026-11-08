import { describe, expect, it } from 'vitest';
import { DEFAULT_BOUNDARY_SIZE, NODE_SIZE, layoutDraft, type DraftLayoutItem, type PlacedNode } from '../src/index.js';

// Where the elements of a draft are drawn (Phase 3 Milestone 4, research #14, FR-060). The model proposes no positions, and a draft's
// layout is not stored: it is computed from the items alone. Each boundary is laid out from the inside out, its members on a grid,
// and sized to hold them with the header and margin the threat model's own diagram uses.

const HEADER = 40;
const MARGIN = 20;

let counter = 0;
const id = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

const node = (type: DraftLayoutItem['type'], boundary_id: string | null = null): DraftLayoutItem => ({ id: id(), type, boundary_id, source_id: null, target_id: null });
const boundary = (parent: string | null = null): DraftLayoutItem => node('trust_boundary', parent);
const flow = (source: string, target: string): DraftLayoutItem => ({ id: id(), type: 'data_flow', boundary_id: null, source_id: source, target_id: target });

const byId = (placed: PlacedNode[]): Map<string, PlacedNode> => new Map(placed.map((p) => [p.id, p]));
const overlap = (a: PlacedNode, b: PlacedNode): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('what is placed', () => {
  it('places nothing for nothing', () => {
    expect(layoutDraft([])).toEqual({ nodes: [], edges: [] });
  });

  it('places every process, data store, external entity and trust boundary, and no data flow', () => {
    const a = node('process');
    const b = node('data_store');
    const c = node('external_entity');
    const d = boundary();
    const f = flow(a.id, b.id);
    const { nodes } = layoutDraft([a, b, c, d, f]);
    expect(nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
  });

  it('draws a node at the size the threat model’s diagram draws it', () => {
    const a = node('process');
    const placed = layoutDraft([a]).nodes[0] as PlacedNode;
    expect(placed).toMatchObject({ id: a.id, width: NODE_SIZE.process.width, height: NODE_SIZE.process.height, parentId: null });
  });

  it('returns each data flow as an edge between its endpoints', () => {
    const a = node('process');
    const b = node('data_store');
    const f = flow(a.id, b.id);
    expect(layoutDraft([a, b, f]).edges).toEqual([{ id: f.id, source: a.id, target: b.id }]);
  });

  it('leaves out an edge whose endpoint is not in the draft, instead of drawing a line to nowhere', () => {
    const a = node('process');
    const f = flow(a.id, id());
    expect(layoutDraft([a, f]).edges).toEqual([]);
  });
});

describe('the grid', () => {
  it('puts at most four nodes in a row, left to right and then down, with a gap', () => {
    const items = Array.from({ length: 9 }, () => node('process'));
    const { nodes } = layoutDraft(items);
    expect(new Set(nodes.map((n) => n.x)).size).toBe(4);
    expect(new Set(nodes.map((n) => n.y)).size).toBe(3);
    const first = nodes[0] as PlacedNode;
    const second = nodes[1] as PlacedNode;
    expect(first).toMatchObject({ x: 0, y: 0 });
    expect(second.y).toBe(0);
    expect(second.x).toBeGreaterThan(first.x + first.width);
  });

  it('puts no two nodes of one level on top of each other, however many there are', () => {
    const outer = boundary();
    const inner = boundary(outer.id);
    const items = [
      outer,
      inner,
      ...Array.from({ length: 7 }, () => node('process', outer.id)),
      ...Array.from({ length: 5 }, () => node('data_store', inner.id)),
      ...Array.from({ length: 6 }, () => node('external_entity')),
    ];
    const { nodes } = layoutDraft(items);
    const groups = new Map<string | null, PlacedNode[]>();
    for (const n of nodes) groups.set(n.parentId, [...(groups.get(n.parentId) ?? []), n]);
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) expect(overlap(group[i] as PlacedNode, group[j] as PlacedNode)).toBe(false);
      }
    }
  });

  it('orders a level by type: processes, then data stores, then external entities, then boundaries, each in the order given', () => {
    const e = node('external_entity');
    const s = node('data_store');
    const p1 = node('process');
    const b = boundary();
    const p2 = node('process');
    const { nodes } = layoutDraft([e, s, p1, b, p2]);
    expect(nodes.map((n) => n.id)).toEqual([p1.id, p2.id, s.id, e.id, b.id]);
  });
});

describe('boundaries', () => {
  it('holds each member wholly inside it, below its header and inside its margin', () => {
    const outer = boundary();
    const members = [node('process', outer.id), node('data_store', outer.id), node('external_entity', outer.id)];
    const placed = byId(layoutDraft([outer, ...members]).nodes);
    const box = placed.get(outer.id) as PlacedNode;
    for (const m of members) {
      const at = placed.get(m.id) as PlacedNode;
      expect(at.parentId).toBe(outer.id);
      expect(at.x).toBeGreaterThanOrEqual(MARGIN);
      expect(at.y).toBeGreaterThanOrEqual(HEADER);
      expect(at.x + at.width).toBeLessThanOrEqual(box.width - MARGIN);
      expect(at.y + at.height).toBeLessThanOrEqual(box.height - MARGIN);
    }
  });

  it('grows to hold many members, and is never smaller than the default size', () => {
    const small = boundary();
    const big = boundary();
    const items = [small, node('process', small.id), big, ...Array.from({ length: 12 }, () => node('process', big.id))];
    const placed = byId(layoutDraft(items).nodes);
    const smallBox = placed.get(small.id) as PlacedNode;
    const bigBox = placed.get(big.id) as PlacedNode;
    expect(smallBox.width).toBeGreaterThanOrEqual(DEFAULT_BOUNDARY_SIZE.width);
    expect(smallBox.height).toBeGreaterThanOrEqual(DEFAULT_BOUNDARY_SIZE.height);
    expect(bigBox.height).toBeGreaterThan(smallBox.height);
    expect(bigBox.width).toBeGreaterThanOrEqual(4 * NODE_SIZE.process.width + 2 * MARGIN);
  });

  it('is the default size when it has no member', () => {
    const empty = boundary();
    expect(layoutDraft([empty]).nodes[0]).toMatchObject({ width: DEFAULT_BOUNDARY_SIZE.width, height: DEFAULT_BOUNDARY_SIZE.height });
  });

  it('holds a boundary nested in a boundary, sized to hold its own members, three deep', () => {
    const a = boundary();
    const b = boundary(a.id);
    const c = boundary(b.id);
    const leaves = Array.from({ length: 6 }, () => node('process', c.id));
    const placed = byId(layoutDraft([a, b, c, ...leaves]).nodes);
    const [boxA, boxB, boxC] = [a, b, c].map((x) => placed.get(x.id) as PlacedNode) as [PlacedNode, PlacedNode, PlacedNode];
    expect(boxB.parentId).toBe(a.id);
    expect(boxC.parentId).toBe(b.id);
    expect(boxB.x + boxB.width).toBeLessThanOrEqual(boxA.width - MARGIN);
    expect(boxC.x + boxC.width).toBeLessThanOrEqual(boxB.width - MARGIN);
    expect(boxC.y + boxC.height).toBeLessThanOrEqual(boxB.height - MARGIN);
    for (const leaf of leaves) {
      const at = placed.get(leaf.id) as PlacedNode;
      expect(at.x + at.width).toBeLessThanOrEqual(boxC.width - MARGIN);
      expect(at.y + at.height).toBeLessThanOrEqual(boxC.height - MARGIN);
    }
  });

  it('puts a member of a boundary the draft does not have at the top, instead of losing it', () => {
    const lost = node('process', id());
    expect(layoutDraft([lost]).nodes[0]).toMatchObject({ id: lost.id, parentId: null });
  });

  it('does not hang on a cycle of boundaries, which a draft never holds: it places every boundary once', () => {
    const a = boundary();
    const b = boundary(a.id);
    const cyclic = { ...a, boundary_id: b.id };
    const { nodes } = layoutDraft([cyclic, b]);
    expect(nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('the same draft always gives the same layout', () => {
  it('is a function of the items and their order', () => {
    const outer = boundary();
    const items = [outer, node('process', outer.id), node('data_store', outer.id), node('external_entity')];
    expect(layoutDraft(items)).toEqual(layoutDraft(items.map((x) => ({ ...x }))));
  });
});
