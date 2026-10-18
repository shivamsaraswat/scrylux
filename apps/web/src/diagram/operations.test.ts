import type { ElementRecord } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { setBoundaryAction } from './membership.js';
import { applyOps, inverseOf, type BatchOp } from './operations.js';
import { MODEL, eid, el } from './test-helpers.js';

// FR-024, FR-024b: every action can be taken back. The inverse of an action is computed from the diagram as it
// was before the action, and applying the action and then its inverse leaves the diagram exactly as it was,
// ids included.

// Two diagrams are the same if they hold the same elements: when they were written is not part of it.
const plain = (elements: readonly ElementRecord[]) =>
  [...elements]
    .map(({ created_at: _created, updated_at: _updated, ...rest }) => rest)
    .sort((a, b) => a.id.localeCompare(b.id));

// The action, then its inverse, then the action again (redo).
function roundTrip(before: readonly ElementRecord[], ops: BatchOp[]) {
  const inverse = inverseOf(MODEL, before, ops);
  const after = applyOps(MODEL, before, ops);
  const undone = applyOps(MODEL, after, inverse);
  const redone = applyOps(MODEL, undone, ops);
  expect(plain(undone), 'undo restores the diagram').toEqual(plain(before));
  expect(plain(redone), 'redo repeats the action').toEqual(plain(after));
  return { inverse, after };
}

const api = el(1, { type: 'process', name: 'API', layout: { x: 100, y: 50 } });
const db = el(2, { type: 'data_store', name: 'DB', layout: { x: 400, y: 50 } });
const query = el(3, { type: 'data_flow', name: 'Query', layout: null, source_element_id: eid(1), target_element_id: eid(2) });

describe('the inverse of one action', () => {
  it('adding an element is undone by deleting it', () => {
    const ops: BatchOp[] = [{ op: 'create', element: { id: eid(9), type: 'process', name: 'New process', layout: { x: 0, y: 0 } } }];
    const { inverse } = roundTrip([api], ops);
    expect(inverse).toEqual([{ op: 'delete', id: eid(9) }]);
  });

  it('moving puts the position back', () => {
    const { inverse } = roundTrip([api, db], [{ op: 'update', id: eid(1), changes: { layout: { x: 160, y: 90 } } }]);
    expect(inverse).toEqual([{ op: 'update', id: eid(1), changes: { layout: { x: 100, y: 50 } } }]);
  });

  it('putting an element that was never placed back puts it back to not placed', () => {
    const unplaced = el(1, { name: 'API', layout: null });
    const { inverse } = roundTrip([unplaced], [{ op: 'update', id: eid(1), changes: { layout: { x: 5, y: 5 } } }]);
    expect(inverse).toEqual([{ op: 'update', id: eid(1), changes: { layout: null } }]);
  });

  it('resizing a boundary puts its size and corner back', () => {
    const vpc = el(4, { type: 'trust_boundary', name: 'VPC', layout: { x: 0, y: 0, width: 300, height: 200 } });
    const { inverse } = roundTrip([vpc], [{ op: 'update', id: eid(4), changes: { layout: { x: -20, y: 10, width: 400, height: 260 } } }]);
    expect(inverse).toEqual([{ op: 'update', id: eid(4), changes: { layout: { x: 0, y: 0, width: 300, height: 200 } } }]);
  });

  it('renaming puts the name back', () => {
    const { inverse } = roundTrip([api], [{ op: 'update', id: eid(1), changes: { name: 'Gateway' } }]);
    expect(inverse).toEqual([{ op: 'update', id: eid(1), changes: { name: 'API' } }]);
  });

  it('changing tags puts the properties back, with the flags that were set', () => {
    const tagged = el(1, { name: 'API', properties: { flags: { internet_facing: true } } });
    const { inverse } = roundTrip([tagged], [{ op: 'update', id: eid(1), changes: { properties: { tags: ['Node 22'], flags: { internet_facing: true } } } }]);
    expect(inverse).toEqual([{ op: 'update', id: eid(1), changes: { properties: { flags: { internet_facing: true } } } }]);
  });

  it('setting a flag from "not assessed" puts back "not assessed"', () => {
    const { inverse, after } = roundTrip([api], [{ op: 'update', id: eid(1), changes: { properties: { flags: { runs_privileged: false } } } }]);
    expect(after.find((e) => e.id === eid(1))?.properties).toEqual({ flags: { runs_privileged: false } });
    expect(inverse).toEqual([{ op: 'update', id: eid(1), changes: { properties: {} } }]);
  });

  it('changing the type puts back the type and the properties that went with it', () => {
    const store = el(1, { type: 'data_store', name: 'Store', properties: { tags: ['PostgreSQL'], flags: { encrypted_at_rest: true } } });
    const { inverse } = roundTrip([store], [{ op: 'update', id: eid(1), changes: { type: 'process', properties: { tags: ['PostgreSQL'] } } }]);
    expect(inverse).toEqual([
      { op: 'update', id: eid(1), changes: { type: 'data_store', properties: { tags: ['PostgreSQL'], flags: { encrypted_at_rest: true } } } },
    ]);
  });

  it('changing the trust boundary puts back both the boundary and the position in its frame', () => {
    const vpc = el(4, { type: 'trust_boundary', name: 'VPC', layout: { x: 200, y: 100, width: 300, height: 200 } });
    const inside = el(1, { name: 'API', layout: { x: 50, y: 60 }, parent_boundary_id: eid(4) });
    const out = roundTrip([vpc, inside], [{ op: 'update', id: eid(1), changes: { parent_boundary_id: null, layout: { x: 250, y: 160 } } }]);
    expect(out.inverse).toEqual([{ op: 'update', id: eid(1), changes: { parent_boundary_id: eid(4), layout: { x: 50, y: 60 } } }]);
    // And the other way, from the panel's own builder.
    const free = el(1, { name: 'API', layout: { x: 10, y: 10 } });
    const action = setBoundaryAction([vpc, free], eid(1), eid(4));
    expect(action).not.toBeNull();
    roundTrip([vpc, free], action?.ops ?? []);
  });

  it('adding a data flow is undone by deleting it', () => {
    const ops: BatchOp[] = [
      { op: 'create', element: { id: eid(9), type: 'data_flow', name: 'Replies', layout: null, source_element_id: eid(2), target_element_id: eid(1) } },
    ];
    const { inverse } = roundTrip([api, db], ops);
    expect(inverse).toEqual([{ op: 'delete', id: eid(9) }]);
  });

  it('deleting a node brings it back with the same id and properties, and its flows with theirs', () => {
    const rich = el(1, { name: 'API', layout: { x: 100, y: 50 }, properties: { tags: ['Node 22'], flags: { internet_facing: true } } });
    const flow = el(3, { type: 'data_flow', name: 'Query', layout: null, source_element_id: eid(1), target_element_id: eid(2), properties: { flags: { encrypted_in_transit: false } } });
    const back = el(5, { type: 'data_flow', name: 'Reply', layout: null, source_element_id: eid(2), target_element_id: eid(1) });
    const { inverse, after } = roundTrip([rich, db, flow, back], [{ op: 'delete', id: eid(1) }]);
    expect(after.map((e) => e.id)).toEqual([eid(2)]);
    // The node first, so the flows have both ends to attach to.
    expect(inverse[0]).toMatchObject({ op: 'create', element: { id: eid(1), name: 'API', properties: { tags: ['Node 22'], flags: { internet_facing: true } } } });
    expect(inverse.slice(1).map((op) => (op.op === 'create' ? op.element.id : null)).sort()).toEqual([eid(3), eid(5)]);
    expect(inverse.every((op) => op.op === 'create')).toBe(true);
  });

  it('deleting a trust boundary brings it back, and gives its members back to it, where they were in its frame', () => {
    const outer = el(4, { type: 'trust_boundary', name: 'Outer', layout: { x: 100, y: 100, width: 800, height: 600 } });
    const inner = el(5, { type: 'trust_boundary', name: 'Inner', layout: { x: 40, y: 60, width: 400, height: 300 }, parent_boundary_id: eid(4) });
    const worker = el(1, { name: 'Worker', layout: { x: 30, y: 50 }, parent_boundary_id: eid(5) });
    const sub = el(6, { type: 'trust_boundary', name: 'Sub', layout: { x: 200, y: 20, width: 100, height: 100 }, parent_boundary_id: eid(5) });
    const { after } = roundTrip([outer, inner, worker, sub, db, query], [{ op: 'delete', id: eid(5) }]);
    // While it is gone the members have moved up, and are drawn where they were.
    expect(after.find((e) => e.id === eid(1))).toMatchObject({ parent_boundary_id: eid(4), layout: { x: 70, y: 110 } });
    expect(after.find((e) => e.id === eid(6))).toMatchObject({ parent_boundary_id: eid(4), layout: { x: 240, y: 80, width: 100, height: 100 } });
  });

  it('deleting a boundary that holds a node with a flow restores the boundary, the member and the flow', () => {
    const vpc = el(4, { type: 'trust_boundary', name: 'VPC', layout: { x: 0, y: 0, width: 300, height: 200 } });
    const member = el(1, { name: 'API', layout: { x: 20, y: 20 }, parent_boundary_id: eid(4) });
    roundTrip([vpc, member, db, query], [{ op: 'delete', id: eid(4) }]);
  });
});

describe('the inverse of an action with several operations', () => {
  it('undoes them last first, so each step starts from the state it was made in', () => {
    const ops: BatchOp[] = [
      { op: 'create', element: { id: eid(9), type: 'process', name: 'New process', layout: { x: 0, y: 0 } } },
      { op: 'update', id: eid(9), changes: { name: 'Worker' } },
      { op: 'update', id: eid(1), changes: { layout: { x: 7, y: 7 } } },
    ];
    const { inverse } = roundTrip([api, db], ops);
    expect(inverse).toEqual([
      { op: 'update', id: eid(1), changes: { layout: { x: 100, y: 50 } } },
      { op: 'update', id: eid(9), changes: { name: 'New process' } },
      { op: 'delete', id: eid(9) },
    ]);
  });

  it('undoes moving a boundary together with what it holds', () => {
    const vpc = el(4, { type: 'trust_boundary', name: 'VPC', layout: { x: 0, y: 0, width: 300, height: 200 } });
    const member = el(1, { name: 'API', layout: { x: 20, y: 20 }, parent_boundary_id: eid(4) });
    roundTrip(
      [vpc, member],
      [
        { op: 'update', id: eid(4), changes: { layout: { x: 60, y: 40, width: 300, height: 200 } } },
        { op: 'update', id: eid(1), changes: { parent_boundary_id: null, layout: { x: 90, y: 90 } } },
      ],
    );
  });

  it('does not invent anything for an element that is not there', () => {
    const before = [api];
    expect(inverseOf(MODEL, before, [{ op: 'update', id: eid(7), changes: { name: 'x' } }])).toEqual([]);
    expect(inverseOf(MODEL, before, [{ op: 'delete', id: eid(7) }])).toEqual([]);
  });

  it('only records what the action changed', () => {
    const [inverse] = inverseOf(MODEL, [api], [{ op: 'update', id: eid(1), changes: { name: 'Gateway' } }]);
    expect(inverse).toEqual({ op: 'update', id: eid(1), changes: { name: 'API' } });
  });
});
