import { elementPropertiesSchema, type DraftElementRecord } from '@scrylux/core';
import { openaiCompletion, openaiEmbeddings, resetCapabilityOverrides, startStub, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { readDraft } from '../../src/extract-system/draft.js';
import { enqueueExtraction, type JobSettings } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, clientFor, localConfig, resetJobTables, waitForState } from '../worker/helpers.js';
import { CHUNK_TEXTS, validAnswer } from '../fixtures/extract-system/answers.js';
import { seedAccount, seedReadySource, seedThreatModel } from '../fixtures/extract-system/seed.js';

// Every element of a stored draft is acceptable as it stands (Phase 3 Milestone 4, FR-033, SC-003): Milestone 5 accepts items into the threat model, so
// a draft item that the threat model's diagram would refuse must never be stored. Here the draft of the richest valid answer is made by a real
// extraction, and each of its elements is then created in a threat model of its own, with the database's own rules (migration 006 and 013) and the shared
// schema of an element's properties as the judge. Boundaries are created before what they hold, and flows after their endpoints, as the diagram does.

const SETTINGS: JobSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 3, timeLimitMs: 3_600_000, jobsPerAccount: 100, providerCheckCooldownMs: 0 };

let stub: Stub;
let alice: number;
let worker: Worker | undefined;

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  await db.query('TRUNCATE sources CASCADE');
  alice = await seedAccount();
  stub = await startStub();
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
  vi.unstubAllEnvs();
});

async function draftOf(answer: unknown) {
  const threatModelId = (await seedThreatModel(alice)).threatModelId;
  await seedReadySource(alice, threatModelId, { name: 'design.md', chunks: [CHUNK_TEXTS.c1, CHUNK_TEXTS.c2, CHUNK_TEXTS.c3] });
  stub.setFallback((r) => (r.path.endsWith('/embeddings') ? openaiEmbeddings([[1, 2, 3]], 3) : openaiCompletion({ content: JSON.stringify(answer), usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })));
  const config = localConfig(stub.url);
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
  const id = await kdb.transaction().execute((trx) => enqueueExtraction(trx, { threatModelId, accountId: alice }, SETTINGS));
  expect((await waitForState(id, ['succeeded', 'failed', 'cancelled'], 30_000)).state).toBe('succeeded');
  const draft = await readDraft(kdb, threatModelId);
  if (draft === undefined) throw new Error('no draft');
  return draft;
}

/** Creates the elements of a draft in a new threat model, the way the diagram would, and returns how many were created. */
async function accept(elements: readonly DraftElementRecord[]): Promise<number> {
  const { threatModelId } = await seedThreatModel(alice);
  const created = new Map<string, string>();
  const insert = async (element: DraftElementRecord, parent: string | null, source: string | null, target: string | null): Promise<void> => {
    // The properties a person could set by hand: the shared schema accepts them, or the draft proposed a flag the diagram would refuse.
    const properties = { flags: Object.fromEntries(element.flags.map((flag) => [flag.flag, flag.value])) };
    const checked = elementPropertiesSchema(element.type).safeParse(properties);
    expect(checked.success, `${element.name}: ${JSON.stringify(properties)}`).toBe(true);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO elements (threat_model_id, type, name, properties, parent_boundary_id, source_element_id, target_element_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [threatModelId, element.type, element.name, JSON.stringify(properties), parent, source, target],
    );
    created.set(element.id, rows[0]?.id as string);
  };

  // Boundaries first, an outer one before the boundaries it holds.
  const pending = elements.filter((e) => e.type === 'trust_boundary');
  while (pending.length > 0) {
    const next = pending.findIndex((e) => e.boundary_id === null || created.has(e.boundary_id));
    expect(next, 'a boundary is nested in a boundary that is nested in it').toBeGreaterThanOrEqual(0);
    const [boundary] = pending.splice(next, 1) as [DraftElementRecord];
    await insert(boundary, boundary.boundary_id === null ? null : (created.get(boundary.boundary_id) as string), null, null);
  }
  for (const element of elements.filter((e) => e.type !== 'trust_boundary' && e.type !== 'data_flow')) {
    await insert(element, element.boundary_id === null ? null : (created.get(element.boundary_id) as string), null, null);
  }
  for (const flow of elements.filter((e) => e.type === 'data_flow')) {
    await insert(flow, null, created.get(flow.source_id as string) as string, created.get(flow.target_id as string) as string);
  }
  return created.size;
}

describe('an element of a draft, accepted into a threat model as it stands', () => {
  it('can be created, all of them, with the rules of the diagram and the schema of its properties', async () => {
    const draft = await draftOf(validAnswer());
    expect(draft.elements.length).toBeGreaterThan(5);
    expect(await accept(draft.elements)).toBe(draft.elements.length);
  });

  it('keeps its flags to those its type allows, and its name to what the diagram accepts', async () => {
    const draft = await draftOf(validAnswer());
    for (const element of draft.elements) {
      expect(element.name.trim().length).toBeGreaterThan(0);
      expect([...element.name].length).toBeLessThanOrEqual(200);
      expect(elementPropertiesSchema(element.type).safeParse({ flags: Object.fromEntries(element.flags.map((f) => [f.flag, f.value])) }).success, element.name).toBe(true);
    }
  });

  it('has a flow only between a process, a data store and an external entity, never in a boundary, and never from an element to itself', async () => {
    const draft = await draftOf(validAnswer());
    const byId = new Map(draft.elements.map((e) => [e.id, e]));
    for (const flow of draft.elements.filter((e) => e.type === 'data_flow')) {
      expect(flow.boundary_id).toBeNull();
      expect(flow.source_id).not.toBe(flow.target_id);
      for (const end of [flow.source_id, flow.target_id]) expect(['process', 'data_store', 'external_entity']).toContain(byId.get(end as string)?.type);
    }
  });

  it('nests boundaries without a cycle, and puts only a boundary above anything', async () => {
    const answer = validAnswer();
    // A third boundary inside the first: nesting that is allowed.
    answer.elements.push({
      ref: 'dmz',
      type: 'trust_boundary',
      name: 'DMZ',
      boundary: 'internet',
      source: null,
      target: null,
      flags: [],
      rationale: 'A zone inside the internet-facing one.',
      citations: [{ chunk: 'c1', quote: 'exposed to the internet' }],
    });
    const draft = await draftOf(answer);
    const byId = new Map(draft.elements.map((e) => [e.id, e]));
    for (const element of draft.elements.filter((e) => e.boundary_id !== null)) expect(byId.get(element.boundary_id as string)?.type).toBe('trust_boundary');
    expect(await accept(draft.elements)).toBe(draft.elements.length);
  });
});
