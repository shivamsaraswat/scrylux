import { describe, expect, it } from 'vitest';
import { assignBoxes, placeBoundary, placeNode, relativeTo } from '../../src/exchange/import/geometry.js';

// Positions from another tool's file (contracts/threat-dragon-mapping.md, "Geometry"): which trust boundary a drawn
// element sits in, and whether Scrylux can hold what was drawn (FR-013, FR-008a).

const box = (id: string, x: number, y: number, width: number, height: number) => ({ id, rect: { x, y, width, height } });
const node = (id: string, x: number, y: number) => ({ id, point: { x, y } });

describe('assignBoxes: a node', () => {
  it('goes to the smallest box that holds its centre', () => {
    const { nodeParent } = assignBoxes([box('outer', 0, 0, 1000, 1000), box('inner', 100, 100, 300, 300)], [node('a', 200, 200), node('b', 800, 800), node('c', 5000, 5000)]);
    expect(nodeParent.get('a')).toBe('inner');
    expect(nodeParent.get('b')).toBe('outer');
    expect(nodeParent.get('c')).toBeNull();
  });

  it('counts the edge of a box as inside', () => {
    const { nodeParent } = assignBoxes([box('b', 0, 0, 100, 100)], [node('corner', 0, 0), node('far', 100, 100), node('out', 100.5, 100)]);
    expect([nodeParent.get('corner'), nodeParent.get('far'), nodeParent.get('out')]).toEqual(['b', 'b', null]);
  });

  it('goes to the box earlier in the file when two of equal area hold it', () => {
    const { nodeParent } = assignBoxes([box('first', 0, 0, 100, 100), box('second', 50, 50, 100, 100)], [node('a', 75, 75)]);
    expect(nodeParent.get('a')).toBe('first');
  });
});

describe('assignBoxes: a box', () => {
  it('goes to the smallest other box that holds all of it, and boxes that only overlap do not nest', () => {
    const { boxParent } = assignBoxes(
      [box('outer', 0, 0, 1000, 1000), box('middle', 100, 100, 500, 500), box('inner', 150, 150, 100, 100), box('overlap', 550, 550, 200, 200)],
      [],
    );
    expect(boxParent.get('outer')).toBeNull();
    expect(boxParent.get('middle')).toBe('outer');
    expect(boxParent.get('inner')).toBe('middle');
    expect(boxParent.get('overlap')).toBe('outer');
  });

  it('nests boxes of exactly the same rectangle inside the first of them, so there is no cycle', () => {
    const { boxParent } = assignBoxes([box('a', 0, 0, 100, 100), box('b', 0, 0, 100, 100), box('c', 0, 0, 100, 100)], []);
    expect([boxParent.get('a'), boxParent.get('b'), boxParent.get('c')]).toEqual([null, 'a', 'a']);
  });

  it('never makes a cycle, whatever is drawn (a seeded property check)', () => {
    let state = 12345;
    const next = (limit: number): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % limit;
    };
    for (let round = 0; round < 200; round += 1) {
      const boxes = Array.from({ length: 12 }, (_unused, index) => box(`b${index}`, next(5) * 20, next(5) * 20, 20 + next(4) * 20, 20 + next(4) * 20));
      const { boxParent } = assignBoxes(boxes, []);
      for (const { id } of boxes) {
        const seen = new Set<string>();
        for (let at: string | null | undefined = id; at !== null && at !== undefined; at = boxParent.get(at)) {
          expect(seen.has(at), `a cycle through ${at}`).toBe(false);
          seen.add(at);
        }
      }
    }
  });
});

describe('relativeTo', () => {
  it('moves a position into the parent’s frame, and leaves a top-level one alone', () => {
    expect(relativeTo({ x: 150, y: 260 }, { x: 100, y: 200 })).toEqual({ x: 50, y: 60 });
    expect(relativeTo({ x: 150, y: 260 }, null)).toEqual({ x: 150, y: 260 });
  });
});

describe('placeNode', () => {
  it('uses a position it can hold, and says nothing when there is none', () => {
    expect(placeNode({ x: 10, y: -20 })).toEqual({ layout: { x: 10, y: -20 }, adjusted: null });
    expect(placeNode(undefined)).toEqual({ layout: null, adjusted: null });
    expect(placeNode(null)).toEqual({ layout: null, adjusted: null });
  });

  it('leaves unplaced a position beyond 100,000, or not a number', () => {
    expect(placeNode({ x: 100_000, y: 0 }).layout).not.toBeNull();
    expect(placeNode({ x: 100_001, y: 0 })).toEqual({ layout: null, adjusted: 'unplaced' });
    expect(placeNode({ x: 0, y: -100_001 })).toEqual({ layout: null, adjusted: 'unplaced' });
    expect(placeNode({ x: Number.NaN, y: 0 })).toEqual({ layout: null, adjusted: 'unplaced' });
  });
});

describe('placeBoundary', () => {
  it('uses a position and size it can hold', () => {
    expect(placeBoundary({ x: 1, y: 2 }, { width: 300, height: 200 })).toEqual({ layout: { x: 1, y: 2, width: 300, height: 200 }, adjusted: null });
  });

  it('enlarges a side smaller than 40 to 40, and says so', () => {
    expect(placeBoundary({ x: 1, y: 2 }, { width: 10, height: 30 })).toEqual({ layout: { x: 1, y: 2, width: 40, height: 40 }, adjusted: 'enlarged' });
    expect(placeBoundary({ x: 1, y: 2 }, { width: 40, height: 40 }).adjusted).toBeNull();
  });

  it('leaves unplaced a boundary with a position but no size, a position or size beyond the limits, and none with no position', () => {
    expect(placeBoundary({ x: 1, y: 2 }, undefined)).toEqual({ layout: null, adjusted: 'unplaced' });
    expect(placeBoundary({ x: 100_001, y: 2 }, { width: 50, height: 50 })).toEqual({ layout: null, adjusted: 'unplaced' });
    expect(placeBoundary({ x: 1, y: 2 }, { width: 100_001, height: 50 })).toEqual({ layout: null, adjusted: 'unplaced' });
    expect(placeBoundary(undefined, { width: 50, height: 50 })).toEqual({ layout: null, adjusted: null });
  });
});
