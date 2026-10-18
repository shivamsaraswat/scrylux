import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { MAX_ELEMENTS } from '@scrylux/core';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  closePool,
  count,
  createElement,
  createProject,
  createThreatModel,
  createUser,
  deleteProjects,
  escapeIdentifier,
  expectPgError,
  pool,
  uid,
} from './helpers.js';

let userId: number;
let modelId: string;
const created: string[] = [];

async function newModel(): Promise<string> {
  const p = await createProject(userId);
  created.push(p.id);
  return (await createThreatModel(p.id)).id;
}

const flow = (model: string, source: string, target: string, overrides: Record<string, unknown> = {}) =>
  createElement(model, 'data_flow', { source_element_id: source, target_element_id: target, ...overrides });

async function setColumn(id: string, column: 'type' | 'parent_boundary_id' | 'threat_model_id', value: string | null) {
  await pool().query(`UPDATE elements SET ${escapeIdentifier(column)} = $1 WHERE id = $2`, [value, id]);
}

beforeAll(async () => {
  userId = (await createUser()).id;
});
beforeEach(async () => {
  modelId = await newModel();
});
afterEach(async () => {
  await deleteProjects(created.splice(0));
});
afterAll(closePool);

describe('elements: name, properties and layout (FR-011, FR-031)', () => {
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['201 characters', 'x'.repeat(201)],
  ])('rejects a name that is %s', async (_label, name) => {
    await expectPgError(createElement(modelId, 'process', { name }), { code: '23514', constraint: 'elements_name_check' });
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(0);
  });

  it('accepts a name of exactly 200 characters, and lets names repeat within a model', async () => {
    await createElement(modelId, 'process', { name: 'x'.repeat(200) });
    await createElement(modelId, 'process', { name: 'Same' });
    await createElement(modelId, 'data_store', { name: 'Same' });
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(3);
  });

  it('defaults properties to an empty object and layout to null', async () => {
    const el = await createElement(modelId, 'process');
    expect(el.properties).toEqual({});
    expect(el.layout).toBeNull();
  });

  it('rejects properties that are not a JSON object', async () => {
    await expectPgError(createElement(modelId, 'process', { properties: '[]' }), {
      code: '23514',
      constraint: 'elements_properties_check',
    });
  });

  it('rejects layout that is neither null nor a JSON object, and accepts an object', async () => {
    await expectPgError(createElement(modelId, 'process', { layout: '1' }), {
      code: '23514',
      constraint: 'elements_layout_check',
    });
    expect((await createElement(modelId, 'process', { layout: '{"x":1,"y":2}' })).layout).toEqual({ x: 1, y: 2 });
  });
});

describe('elements: type (FR-012, FR-012a)', () => {
  it('rejects an unknown type and accepts all five known ones', async () => {
    await expectPgError(createElement(modelId, 'actor'), { code: '23514', constraint: 'elements_type_check' });

    const a = await createElement(modelId, 'external_entity');
    const b = await createElement(modelId, 'process');
    await createElement(modelId, 'data_store');
    await createElement(modelId, 'trust_boundary');
    await flow(modelId, a.id, b.id);
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(5);
  });

  it('lets external entities, processes and data stores switch among themselves', async () => {
    const el = await createElement(modelId, 'process');
    await setColumn(el.id, 'type', 'data_store');
    await setColumn(el.id, 'type', 'external_entity');
    await setColumn(el.id, 'type', 'process');
  });

  it('keeps a flow valid when one of its endpoints changes type', async () => {
    const a = await createElement(modelId, 'external_entity');
    const b = await createElement(modelId, 'process');
    const f = await flow(modelId, a.id, b.id);

    await setColumn(b.id, 'type', 'data_store');

    expect(await count('elements', { column: 'id', value: f.id })).toBe(1);
  });

  it.each([
    ['process', 'trust_boundary'],
    ['process', 'data_flow'],
    ['data_flow', 'process'],
    ['trust_boundary', 'process'],
  ])('rejects changing %s to %s', async (from, to) => {
    const a = await createElement(modelId, 'external_entity');
    const b = await createElement(modelId, 'process');
    const el =
      from === 'data_flow'
        ? await flow(modelId, a.id, b.id)
        : await createElement(modelId, from);

    await expectPgError(pool().query('UPDATE elements SET type = $1 WHERE id = $2', [to, el.id]), {
      code: '23514',
      constraint: 'elements_type_class_immutable',
    });
    const { rows } = await pool().query<{ type: string }>('SELECT type FROM elements WHERE id = $1', [el.id]);
    expect(rows[0]?.type).toBe(from);
  });
});

describe('elements: data-flow endpoints (FR-013, FR-014)', () => {
  it('rejects a data flow without a target', async () => {
    const a = await createElement(modelId, 'process');
    await expectPgError(createElement(modelId, 'data_flow', { source_element_id: a.id }), {
      code: '23514',
      constraint: 'elements_flow_endpoints',
    });
  });

  it('rejects a non-flow element that has a source', async () => {
    const a = await createElement(modelId, 'process');
    await expectPgError(createElement(modelId, 'data_store', { source_element_id: a.id }), {
      code: '23514',
      constraint: 'elements_flow_endpoints',
    });
  });

  it('rejects an endpoint that belongs to another threat model', async () => {
    const otherModel = await newModel();
    const mine = await createElement(modelId, 'process');
    const theirs = await createElement(otherModel, 'external_entity');

    await expectPgError(flow(modelId, theirs.id, mine.id), { code: '23503', constraint: 'elements_source_fkey' });
    await expectPgError(flow(modelId, mine.id, theirs.id), { code: '23503', constraint: 'elements_target_fkey' });
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(1);
  });

  it.each(['trust_boundary', 'data_flow'])('rejects a %s as an endpoint', async (badType) => {
    const a = await createElement(modelId, 'external_entity');
    const b = await createElement(modelId, 'process');
    const bad = badType === 'data_flow' ? await flow(modelId, a.id, b.id) : await createElement(modelId, badType);

    await expectPgError(flow(modelId, bad.id, b.id), { code: '23514', constraint: 'elements_flow_endpoint_type' });
    await expectPgError(flow(modelId, a.id, bad.id), { code: '23514', constraint: 'elements_flow_endpoint_type' });
  });

  it('rejects a self-loop', async () => {
    const a = await createElement(modelId, 'process');
    await expectPgError(flow(modelId, a.id, a.id), { code: '23514', constraint: 'elements_flow_not_self_loop' });
  });
});

describe('elements: parent boundary (FR-015, FR-016)', () => {
  it('accepts a boundary, a node and another boundary inside a boundary', async () => {
    const b1 = await createElement(modelId, 'trust_boundary');
    await createElement(modelId, 'process', { parent_boundary_id: b1.id });
    await createElement(modelId, 'trust_boundary', { parent_boundary_id: b1.id });
    expect(await count('elements', { column: 'parent_boundary_id', value: b1.id })).toBe(2);
  });

  it('rejects a parent that is not a trust boundary', async () => {
    const p = await createElement(modelId, 'process');
    await expectPgError(createElement(modelId, 'process', { parent_boundary_id: p.id }), {
      code: '23514',
      constraint: 'elements_parent_is_boundary',
    });
  });

  it('rejects a parent boundary that belongs to another threat model', async () => {
    const foreign = await createElement(await newModel(), 'trust_boundary');
    await expectPgError(createElement(modelId, 'process', { parent_boundary_id: foreign.id }), {
      code: '23514',
      constraint: 'elements_parent_is_boundary',
    });
  });

  it('rejects a parent that does not exist', async () => {
    await expectPgError(createElement(modelId, 'process', { parent_boundary_id: randomUUID() }), {
      code: '23503',
      constraint: 'elements_parent_fkey',
    });
  });

  it('rejects a parent on a data flow', async () => {
    const b = await createElement(modelId, 'trust_boundary');
    const a = await createElement(modelId, 'external_entity');
    const p = await createElement(modelId, 'process');
    await expectPgError(flow(modelId, a.id, p.id, { parent_boundary_id: b.id }), {
      code: '23514',
      constraint: 'elements_flow_no_parent',
    });
  });

  it('rejects a boundary being its own parent, on insert and on update', async () => {
    const id = randomUUID();
    await expectPgError(createElement(modelId, 'trust_boundary', { id, parent_boundary_id: id }), {
      code: '23514',
      constraint: 'elements_parent_not_self',
    });
    const b = await createElement(modelId, 'trust_boundary');
    await expectPgError(setColumn(b.id, 'parent_boundary_id', b.id), {
      code: '23514',
      constraint: 'elements_parent_not_self',
    });
  });

  it('rejects a two-level and a three-level cycle', async () => {
    const b1 = await createElement(modelId, 'trust_boundary');
    const b2 = await createElement(modelId, 'trust_boundary', { parent_boundary_id: b1.id });
    await expectPgError(setColumn(b1.id, 'parent_boundary_id', b2.id), {
      code: '23514',
      constraint: 'elements_boundary_no_cycle',
    });

    const b3 = await createElement(modelId, 'trust_boundary', { parent_boundary_id: b2.id });
    await expectPgError(setColumn(b1.id, 'parent_boundary_id', b3.id), {
      code: '23514',
      constraint: 'elements_boundary_no_cycle',
    });
    const { rows } = await pool().query<{ parent_boundary_id: string | null }>(
      'SELECT parent_boundary_id FROM elements WHERE id = $1',
      [b1.id],
    );
    expect(rows[0]?.parent_boundary_id).toBeNull();
  });

  // Two transactions that each look acyclic must not both commit (research.md #8). Re-parenting is
  // serialized per threat model, so the second one waits and then sees the first one's result.
  it('serializes concurrent re-parenting so two moves cannot form a cycle', async () => {
    const b1 = await createElement(modelId, 'trust_boundary');
    const b2 = await createElement(modelId, 'trust_boundary');
    const a = await pool().connect();
    const b = await pool().connect();
    try {
      await a.query('BEGIN');
      await a.query('UPDATE elements SET parent_boundary_id = $1 WHERE id = $2', [b2.id, b1.id]);

      const pendingB = b.query('UPDATE elements SET parent_boundary_id = $1 WHERE id = $2', [b1.id, b2.id]);
      const outcome = await Promise.race([
        pendingB.then(
          () => 'finished',
          () => 'finished',
        ),
        sleep(300).then(() => 'waiting'),
      ]);
      expect(outcome).toBe('waiting');

      await a.query('COMMIT');
      await expectPgError(pendingB, { code: '23514', constraint: 'elements_boundary_no_cycle' });

      const { rows } = await pool().query<{ n: number }>(
        'SELECT count(*)::int AS n FROM elements WHERE id = ANY($1::uuid[]) AND parent_boundary_id IS NOT NULL',
        [[b1.id, b2.id]],
      );
      expect(rows[0]?.n).toBe(1);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });
});

describe('elements: staying in their threat model', () => {
  it('rejects moving an element that nothing references to another threat model', async () => {
    const other = await newModel();
    const lone = await createElement(modelId, 'process', { name: `lone-${uid()}` });

    await expectPgError(setColumn(lone.id, 'threat_model_id', other), {
      code: '23514',
      constraint: 'elements_threat_model_immutable',
    });
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(1);
  });
});

describe('elements: the limit per threat model (FR-001a, 013)', () => {
  const fill = (model: string, n: number) =>
    pool().query(
      `INSERT INTO elements (threat_model_id, type, name) SELECT $1, 'process', 'p' || g FROM generate_series(1, $2::int) g`,
      [model, n],
    );
  const insertOne = () =>
    pool().query(`INSERT INTO elements (threat_model_id, type, name) VALUES ($1, 'process', 'one-more')`, [modelId]);

  it('allows exactly 1,000 and rejects the 1,001st with elements_limit', async () => {
    await fill(modelId, 999);
    await insertOne();
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(1000);

    await expectPgError(insertOne(), { code: '23514', constraint: 'elements_limit' });
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(1000);
  });

  it('rejects a bulk insert that would cross the limit as a whole', async () => {
    await expectPgError(fill(modelId, 1001), { code: '23514', constraint: 'elements_limit' });
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(0);
  });

  it('counts each threat model on its own', async () => {
    const other = await newModel();
    await fill(modelId, 1000);
    await expect(createElement(other, 'process')).resolves.toBeDefined();
  });

  it('lets two parallel inserts at 999 through only once', async () => {
    await fill(modelId, 999);
    const results = await Promise.allSettled([insertOne(), insertOne()]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as { constraint?: string }).constraint).toBe('elements_limit');
    expect(await count('elements', { column: 'threat_model_id', value: modelId })).toBe(1000);
  });

  it('does not affect updates and deletes at the limit, and a delete frees a slot', async () => {
    await fill(modelId, 1000);
    const { rows } = await pool().query<{ id: string }>('SELECT id FROM elements WHERE threat_model_id = $1 LIMIT 1', [modelId]);
    const id = rows[0]?.id as string;

    await pool().query(`UPDATE elements SET name = 'renamed' WHERE id = $1`, [id]);
    await pool().query('DELETE FROM elements WHERE id = $1', [id]);
    await expect(insertOne()).resolves.toBeDefined();
  });

  it('keeps the limit in the migration equal to MAX_ELEMENTS in @scrylux/core', async () => {
    const sql = await readFile(new URL('../migrations/013_element_limit.sql', import.meta.url), 'utf8');
    const match = /max_elements\s+CONSTANT\s+integer\s*:=\s*(\d+)/i.exec(sql);
    expect(match, 'the migration must declare max_elements CONSTANT integer := <n>').not.toBeNull();
    expect(Number(match?.[1])).toBe(MAX_ELEMENTS);
  });
});
