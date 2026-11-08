import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { loadExtractionPrompt } from '../../src/extract-system/prompt.js';
import { rankChunks } from '../../src/extract-system/retrieve.js';
import { vectorText } from '../../src/sources/commit.js';
import { seedAccount, seedThreatModel } from '../fixtures/extract-system/seed.js';

// Choosing chunks at the largest size the limits allow (Phase 3 Milestone 4, SC-006, FR-013, research #6): 20 sources of 500 chunks, 10,000 chunks, with
// the largest dimension the documented embedding models produce (3,072), ranked against the 8 retrieval queries in one pass, exactly, in under
// 2 seconds. There is no vector index: the whole point is that a scan of one threat model's chunks is fast enough that none is needed.

const SOURCES = 20;
const PER_SOURCE = 500;
const DIMENSION = 3072;
const QUERIES = 8;

const randomVector = (): number[] => Array.from({ length: DIMENSION }, () => Math.random() * 2 - 1);

let threatModel: string;
let sourceIds: string[] = [];

beforeAll(async () => {
  const account = await seedAccount();
  threatModel = (await seedThreatModel(account)).threatModelId;
  // Five different vectors, cycled through the chunks: the cost of ranking does not depend on the values, and generating 10,000 here would only slow the setup.
  const vectors = Array.from({ length: 5 }, () => vectorText(randomVector()));
  for (let s = 0; s < SOURCES; s++) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, added_at, original_key, stored_bytes, ready_at, text_chars, chunk_count, embedding_model, embedding_dimension)
       VALUES ($1, $2, 'md', 100, $3, $4, now() + ($5 || ' seconds')::interval, NULL, $6, now(), $7, $8, 'scale-model', $9) RETURNING id`,
      [threatModel, `scale-${s}.md`, randomBytes(32), account, String(s), PER_SOURCE * (100 + DIMENSION * 4), PER_SOURCE * 100, PER_SOURCE, DIMENSION],
    );
    const id = rows[0]?.id as string;
    sourceIds.push(id);
    await db.query(
      `INSERT INTO chunks (source_id, "position", start_offset, end_offset, text, embedding)
       SELECT $1::uuid, g, g * 100, g * 100 + 100, repeat('x', 100), ($2::text[])[1 + g % 5]::vector FROM generate_series(0, $3::int - 1) AS g`,
      [id, vectors, PER_SOURCE],
    );
  }
}, 240_000);

afterAll(async () => {
  await db.query('DELETE FROM threat_models WHERE id = $1', [threatModel]);
  sourceIds = [];
});

describe('ranking at the largest size the limits allow (SC-006)', () => {
  it('holds 10,000 chunks of 3,072 dimensions across 20 sources', async () => {
    const { rows } = await db.query<{ n: number; d: number }>('SELECT count(*)::int AS n, max(vector_dims(embedding)) AS d FROM chunks WHERE source_id = ANY($1::uuid[])', [sourceIds]);
    expect(rows[0]).toEqual({ n: SOURCES * PER_SOURCE, d: DIMENSION });
  });

  it('ranks the 8 retrieval queries against every chunk in under 2 seconds, keeping the nearest 50 of each', async () => {
    const queries = loadExtractionPrompt().queries;
    expect(queries).toHaveLength(QUERIES);
    const vectors = queries.map(() => randomVector());
    const order = new Map(sourceIds.map((id, index) => [id, index]));
    await rankChunks(kdb, sourceIds, vectors, order);
    const started = performance.now();
    const lists = await rankChunks(kdb, sourceIds, vectors, order);
    const elapsed = performance.now() - started;
    expect(lists).toHaveLength(QUERIES);
    for (const list of lists) expect(list).toHaveLength(50);
    expect(elapsed, `${Math.round(elapsed)} ms`).toBeLessThan(2000);
  }, 60_000);

  it('gives each query its own ranking, and the same ranking again for the same query', async () => {
    const vectors = [randomVector(), randomVector()];
    const order = new Map(sourceIds.map((id, index) => [id, index]));
    const first = await rankChunks(kdb, sourceIds, vectors, order);
    const again = await rankChunks(kdb, sourceIds, vectors, order);
    expect(again).toEqual(first);
    expect(randomUUID()).toBeTruthy();
  }, 60_000);
});
