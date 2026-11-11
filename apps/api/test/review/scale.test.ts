import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { readDraft, type StoredDraft } from '../../src/extract-system/draft.js';
import { readReview } from '../../src/review/compare.js';
import { accept } from '../../src/review/decide.js';
import { seedAccount, seedReadySource, seedThreatModel } from '../fixtures/extract-system/seed.js';
import { acceptBody } from '../fixtures/review/seed.js';

// The cost of a decision at the largest size (Phase 3 Milestone 5, SC-005): a whole draft of 40 elements, 15 assets and 15 assumptions accepted into a threat model
// of 960 elements, which then holds its limit of 1,000, takes under two seconds, and reading the draft with its review for a threat model that full takes under
// 300 ms. The numbers are the spec's; if they are missed, find the cost with EXPLAIN ANALYZE and fix the statement, not the number.

let account: number;
let threatModelId: string;
let draftId: string;
let ids: string[];

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  account = await seedAccount();
  threatModelId = (await seedThreatModel(account)).threatModelId;
  await db.query(`INSERT INTO elements (threat_model_id, type, name) SELECT $1, 'process', 'existing ' || n FROM generate_series(1, 960) AS n`, [threatModelId]);
  const source = await seedReadySource(account, threatModelId, { chunks: ['The design says that a great many things happen in many places, in a long enough sentence.'] });
  const chunkId = source.chunkIds[0] as string;

  // 1 boundary, 30 processes inside it, 5 external entities and 4 data flows between processes: 40 elements; 15 assets with three holders each; 15 assumptions.
  const boundary = randomUUID();
  const processes = Array.from({ length: 30 }, () => randomUUID());
  const entities = Array.from({ length: 5 }, () => randomUUID());
  const flows = Array.from({ length: 4 }, () => randomUUID());
  const assets = Array.from({ length: 15 }, () => randomUUID());
  const assumptions = Array.from({ length: 15 }, () => randomUUID());
  ids = [boundary, ...processes, ...entities, ...flows, ...assets, ...assumptions];

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO drafts (threat_model_id, started_by, generation_model, prompt_version, path, chunks_read, chunks_available, sources_total)
       VALUES ($1, $2, 'scale-model', 'extract-system/0123456789ab', 'whole', 1, 1, 1) RETURNING id`,
      [threatModelId, account],
    );
    draftId = rows[0]?.id as string;
    await client.query('INSERT INTO draft_sources (draft_id, source_id, read) VALUES ($1, $2, true)', [draftId, source.sourceId]);
    await client.query('INSERT INTO draft_read_chunks (draft_id, chunk_id, label) VALUES ($1, $2, 1)', [draftId, chunkId]);
    let position = 0;
    const insert = async (id: string, kind: string, name: string | null, body: string | null, extra: { boundary?: string; source?: string; target?: string; flags?: object } = {}): Promise<void> => {
      await client.query(
        `INSERT INTO draft_items (id, draft_id, "position", kind, name, body, rationale, boundary_id, source_item_id, target_item_id, flags) VALUES ($1, $2, $3, $4, $5, $6, 'Because.', $7, $8, $9, $10)`,
        [id, draftId, position++, kind, name, body, extra.boundary ?? null, extra.source ?? null, extra.target ?? null, JSON.stringify(extra.flags ?? {})],
      );
      await client.query('INSERT INTO draft_citations (item_id, "position", chunk_id, quote_start, quote_end) VALUES ($1, 0, $2, 0, 20)', [id, chunkId]);
    };
    await insert(boundary, 'trust_boundary', 'Scale boundary', null);
    for (const [n, id] of processes.entries()) await insert(id, 'process', `Scale process ${n}`, null, { boundary, flags: { internet_facing: n % 2 === 0 } });
    for (const [n, id] of entities.entries()) await insert(id, 'external_entity', `Scale entity ${n}`, null);
    for (const [n, id] of flows.entries()) await insert(id, 'data_flow', `Scale flow ${n}`, null, { source: processes[n] as string, target: processes[n + 1] as string });
    for (const [n, id] of assets.entries()) {
      await insert(id, 'asset', `Scale asset ${n}`, `About ${n}.`);
      for (const holder of processes.slice(n, n + 3)) await client.query('INSERT INTO draft_asset_holders (asset_id, element_id) VALUES ($1, $2)', [id, holder]);
    }
    for (const [n, id] of assumptions.entries()) await insert(id, 'assumption', null, `Scale assumption ${n}.`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

describe('a whole draft at the limits', () => {
  it('is accepted in under two seconds, and the threat model then holds its 1,000 elements', async () => {
    const body = await acceptBody(threatModelId, draftId, ids);
    const started = performance.now();
    const result = await accept(threatModelId, account, body);
    const took = performance.now() - started;
    expect(result).toMatchObject({ created: 70, changed: 0 });
    expect(took, `a whole draft took ${Math.round(took)} ms`).toBeLessThan(2000);
    const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM elements WHERE threat_model_id = $1', [threatModelId]);
    expect(Number(rows[0]?.n)).toBe(1000);
  });

  it('is read with its review in under 300 ms for a threat model that holds 1,000 elements', async () => {
    await accept(threatModelId, account, await acceptBody(threatModelId, draftId, ids));
    // Read once to warm the connection and the plans, then measure.
    await readReview(kdb, (await readDraft(kdb, threatModelId)) as StoredDraft);
    const started = performance.now();
    const draft = (await readDraft(kdb, threatModelId)) as StoredDraft;
    const review = await readReview(kdb, draft);
    const took = performance.now() - started;
    expect(Object.keys(review)).toHaveLength(70);
    expect(took, `reading a draft with its review took ${Math.round(took)} ms`).toBeLessThan(300);
  });
});
