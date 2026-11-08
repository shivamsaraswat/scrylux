import { openaiCompletion, openaiEmbeddings, openaiError, resetCapabilityOverrides, startStub, type RecordedRequest, type Scripted, type Stub } from '@scrylux/llm/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { readDraft } from '../../src/extract-system/draft.js';
import { cancelJob, enqueueExtraction, getDetail, getJob, type JobSettings } from '../../src/jobs/store.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, clientFor, generationRequests, embeddingRequests, localConfig, resetJobTables, sleep, waitFor, waitForState, watch } from '../worker/helpers.js';
import { CHUNK_TEXTS, validAnswer } from '../fixtures/extract-system/answers.js';
import { seedAccount, seedReadySource, seedThreatModel, seedUnreadySource } from '../fixtures/extract-system/seed.js';

// An extraction end to end (Phase 3 Milestone 4, US1, US3, US7; FR-040 to FR-052, SC-003 to SC-005): the real worker, in-process, against a
// stub generation and embedding provider and the real database. A job goes from the API's start to the stored draft, and the tests look at what
// a person and the next milestone depend on: the steps, the request, what is stored, what is not, and what a failure leaves.

const SETTINGS: JobSettings = { tokenCap: 500_000, costCapUsd: 5, maxRuns: 3, timeLimitMs: 3_600_000, jobsPerAccount: 100, providerCheckCooldownMs: 0 };

let stub: Stub;
let alice: number;
let threatModel: string;
let worker: Worker | undefined;

const usage = { prompt_tokens: 900, completion_tokens: 500, total_tokens: 1400 };
const answered = (answer: unknown = validAnswer()): Scripted => openaiCompletion({ content: JSON.stringify(answer), usage });

/** An /embeddings answer with one vector per input. */
const embedded = (r: RecordedRequest): Scripted => {
  const body = r.body as { input?: string | string[] } | undefined;
  const inputs = Array.isArray(body?.input) ? body.input : [body?.input ?? ''];
  return openaiEmbeddings(inputs.map((_, i) => [1 + (i % 3), 2, 3]), inputs.length * 3);
};

const respond = (answer: () => Scripted = () => answered()) => (r: RecordedRequest): Scripted => (r.path.endsWith('/embeddings') ? embedded(r) : answer());

async function startWorkerNow(): Promise<Worker> {
  const config = localConfig(stub.url);
  worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
  return worker;
}

const start = (id = threatModel): Promise<string> => kdb.transaction().execute((trx) => enqueueExtraction(trx, { threatModelId: id, accountId: alice }, SETTINGS));
const ended = (id: string) => waitForState(id, ['succeeded', 'failed', 'cancelled'], 30_000);

/** Three chunks that the fixture answer cites: its labels c1, c2 and c3. */
const seedDesign = (name = 'design.md') => seedReadySource(alice, threatModel, { name, chunks: [CHUNK_TEXTS.c1, CHUNK_TEXTS.c2, CHUNK_TEXTS.c3] });

beforeEach(async () => {
  resetCapabilityOverrides();
  await resetJobTables();
  await db.query('TRUNCATE sources CASCADE');
  alice = await seedAccount();
  threatModel = (await seedThreatModel(alice)).threatModelId;
  stub = await startStub();
  stub.setFallback(respond());
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await stub.close();
  vi.unstubAllEnvs();
});

const messages = (r: RecordedRequest): Array<{ role: string; content: string }> => (r.body as { messages: Array<{ role: string; content: string }> }).messages;
const countOf = async (table: string): Promise<number> => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? 0;

describe('an extraction that succeeds, on the whole path', () => {
  it('goes through the steps select, generate and store (FR-040)', async () => {
    // Every change of the job's progress is recorded by the database itself, so that a step as short as choosing the chunks cannot be
    // missed by a sampler (as in Milestone 3's ingestion test).
    await db.query('CREATE TABLE IF NOT EXISTS progress_log (n BIGSERIAL PRIMARY KEY, job_id UUID, step TEXT, done INTEGER, total INTEGER)');
    await db.query('TRUNCATE progress_log');
    await db.query(`CREATE OR REPLACE FUNCTION log_progress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO progress_log (job_id, step, done, total) VALUES (NEW.id, NEW.progress->>'step', (NEW.progress->>'done')::int, (NEW.progress->>'total')::int);
      RETURN NEW; END $$`);
    await db.query('DROP TRIGGER IF EXISTS log_progress ON jobs');
    await db.query('CREATE TRIGGER log_progress AFTER UPDATE OF progress ON jobs FOR EACH ROW WHEN (NEW.progress IS NOT NULL AND NEW.progress IS DISTINCT FROM OLD.progress) EXECUTE FUNCTION log_progress()');
    try {
      await seedDesign();
      const id = await start();
      const watcher = watch(id);
      await startWorkerNow();
      await ended(id);
      await watcher.stop();
      // The job may leave the queue before the first look at it.
      expect(watcher.states.slice(-2)).toEqual(['running', 'succeeded']);
      const { rows } = await db.query<{ step: string }>('SELECT step FROM progress_log WHERE job_id = $1 ORDER BY n', [id]);
      expect(rows.map((row) => row.step).filter((step, i, all) => all[i - 1] !== step)).toEqual(['select', 'generate', 'store']);
    } finally {
      await db.query('DROP TRIGGER IF EXISTS log_progress ON jobs');
      await db.query('DROP FUNCTION IF EXISTS log_progress()');
      await db.query('DROP TABLE IF EXISTS progress_log');
    }
  });

  it('stores the draft with every item of the answer, its sources and its model, and reads all the chunks (FR-014, FR-025)', async () => {
    const { sourceId } = await seedDesign();
    const id = await start();
    await startWorkerNow();
    expect((await ended(id)).state).toBe('succeeded');

    const draft = await readDraft(kdb, threatModel);
    expect(draft).toBeDefined();
    expect(draft).toMatchObject({
      threat_model_id: threatModel,
      job_id: id,
      path: 'whole',
      chunks_read: 3,
      chunks_available: 3,
      generation_model: 'llama3.2',
      started_by: { id: alice },
      sources: [{ id: sourceId, name: 'design.md', read: true }],
      sources_deleted: 0,
      sources_changed: false,
      nothing_found: null,
    });
    expect(draft?.prompt_version).toMatch(/^extract-system\/[0-9a-f]{12}$/);
    expect(draft?.elements).toHaveLength(9);
    expect(draft?.assets).toHaveLength(1);
    expect(draft?.assumptions).toHaveLength(1);
    expect(draft?.read_chunks).toEqual([0, 1, 2].map((position) => ({ source_id: sourceId, position })));
  });

  it('resolves references, labels and quotes: a flow joins the items it names, and a citation shows its quote from its chunk (FR-022, FR-062)', async () => {
    await seedDesign();
    const id = await start();
    await startWorkerNow();
    await ended(id);
    const draft = await readDraft(kdb, threatModel);
    const byName = (name: string) => draft?.elements.find((e) => e.name === name);
    const flow = byName('Threat data');
    expect(flow).toMatchObject({ type: 'data_flow', source_id: byName('API')?.id, target_id: byName('Database')?.id, boundary_id: null });
    expect(byName('API')).toMatchObject({ type: 'process', boundary_id: byName('Internet')?.id });
    expect(byName('API')?.flags).toEqual([{ flag: 'internet_facing', value: true, citations: [expect.objectContaining({ quote: 'The API is exposed to the internet' })] }]);
    expect(draft?.assets[0]).toMatchObject({ name: 'Threat data', held_by: [byName('Database')?.id] });
    const cited = byName('API')?.citations[0];
    expect(cited?.quote).toBe('served by the API');
    expect(cited?.chunk).toMatchObject({ source_name: 'design.md', position: 0, line_first: 1, heading: 'Architecture' });
  });

  it('keeps counts and two settings as the job’s result, and no text (FR-065)', async () => {
    await seedDesign();
    const id = await start();
    await startWorkerNow();
    await ended(id);
    const detail = await getDetail(kdb, id);
    expect(detail?.extraction).toEqual({
      path: 'whole',
      chunks_read: 3,
      chunks_available: 3,
      sources_read: 1,
      sources_left_out: 0,
      items: { elements: 9, assets: 1, assumptions: 1 },
      context_chars: 36_000,
      max_output_tokens: 12_000,
    });
    expect(detail?.ingestion).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('Payment');
  });

  it('refers to the threat model by its own column and holds nothing in its input (FR-041)', async () => {
    await seedDesign();
    const id = await start();
    const { rows } = await db.query<{ input: unknown; threat_model_id: string; source_id: string | null }>('SELECT input, threat_model_id, source_id FROM jobs WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ input: {}, threat_model_id: threatModel, source_id: null });
  });

  it('sends the sources’ text only in the user turn, under labels, and no identifier and no tool (FR-020, FR-036, FR-037)', async () => {
    // A name of its own: the instructions’ example header names design.md.
    const { sourceId, chunkIds } = await seedDesign('payments-architecture.md');
    const id = await start();
    await startWorkerNow();
    await ended(id);
    const requests = generationRequests(stub);
    expect(requests).toHaveLength(1);
    const [request] = requests as [RecordedRequest];
    const system = messages(request).find((m) => m.role === 'system')?.content ?? '';
    const user = messages(request).find((m) => m.role === 'user')?.content ?? '';

    // The chunks, under their labels with a header naming the source and the lines, and the instructions apart from them.
    expect(user).toContain('[c1] payments-architecture.md, lines 1-3, section: Architecture');
    expect(user).toContain(CHUNK_TEXTS.c1);
    expect(user).toContain('[c3] payments-architecture.md');
    expect(system).toContain('You describe the system that a set of documents describes');
    for (const text of Object.values(CHUNK_TEXTS)) expect(system).not.toContain(text);
    expect(system).not.toContain('payments-architecture.md');

    // No identifier of the install is in the request, and the model is offered no tool.
    for (const identifier of [sourceId, threatModel, id, ...chunkIds]) expect(request.raw).not.toContain(identifier);
    const body = request.body as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.functions).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('makes no embedding request: a small input is read whole and needs none (FR-011)', async () => {
    await seedDesign();
    const id = await start();
    await startWorkerNow();
    await ended(id);
    expect(embeddingRequests(stub)).toHaveLength(0);
  });

  it('records the usage of its request against the job (FR-043)', async () => {
    await seedDesign();
    const id = await start();
    await startWorkerNow();
    await ended(id);
    const detail = await getDetail(kdb, id);
    expect(detail?.usage).toHaveLength(1);
    expect(detail?.usage[0]).toMatchObject({ operation: 'generate', input_tokens: 900, output_tokens: 500, outcome: 'ok' });
  });

  it('changes no element, threat or mitigation of the threat model, however it ends (FR-050, SC-005)', async () => {
    await seedDesign();
    const { rows: element } = await db.query<{ id: string }>(`INSERT INTO elements (threat_model_id, type, name) VALUES ($1, 'process', 'Existing') RETURNING id`, [threatModel]);
    await db.query(`INSERT INTO threats (threat_model_id, element_id, category, title, description, likelihood, impact, origin) VALUES ($1, $2, 'Spoofing', 'T', 'D', 'Low', 'Low', 'manual')`, [threatModel, element[0]?.id]);
    const snapshot = async () => JSON.stringify([
      (await db.query('SELECT * FROM elements ORDER BY id')).rows,
      (await db.query('SELECT * FROM threats ORDER BY id')).rows,
      (await db.query('SELECT * FROM mitigations ORDER BY id')).rows,
    ]);
    const before = await snapshot();
    const id = await start();
    await startWorkerNow();
    await ended(id);
    expect(await snapshot()).toBe(before);
    expect(await countOf('drafts')).toBe(1);
  });

  it('makes a draft with no item, and its reason, when the documents describe no system (FR-024)', async () => {
    await seedDesign();
    stub.setFallback(respond(() => answered({ elements: [], assets: [], assumptions: [], nothing_found: 'The documents describe no system.' })));
    const id = await start();
    await startWorkerNow();
    expect((await ended(id)).state).toBe('succeeded');
    const draft = await readDraft(kdb, threatModel);
    expect(draft).toMatchObject({ elements: [], assets: [], assumptions: [], nothing_found: 'The documents describe no system.' });
  });

  it('names a source it left out because it was not ready, and says nothing of it as read (FR-004)', async () => {
    await seedDesign();
    const failed = await seedUnreadySource(alice, threatModel, 'failed', 'scan.pdf');
    const id = await start();
    await startWorkerNow();
    expect((await ended(id)).state).toBe('succeeded');
    const draft = await readDraft(kdb, threatModel);
    expect(draft?.sources.map((s) => [s.name, s.read])).toEqual([['design.md', true], ['scan.pdf', false]]);
    expect(draft?.sources.find((s) => s.name === 'scan.pdf')?.id).toBe(failed);
    expect((await getDetail(kdb, id))?.extraction).toMatchObject({ sources_read: 1, sources_left_out: 1 });
  });
});

describe('a new extraction and a draft that already exists (FR-052)', () => {
  it('replaces the draft when it succeeds: there is one draft, and it is the new one', async () => {
    await seedDesign();
    await startWorkerNow();
    const first = await start();
    await ended(first);
    const before = await readDraft(kdb, threatModel);
    const second = await start();
    await ended(second);
    const after = await readDraft(kdb, threatModel);
    expect(await countOf('drafts')).toBe(1);
    expect(after?.job_id).toBe(second);
    expect(after?.id).not.toBe(before?.id);
    expect(await countOf('draft_items')).toBe(11);
  });

  it('keeps the draft as it was when the new extraction fails, and says why (FR-035, SC-004)', async () => {
    await seedDesign();
    await startWorkerNow();
    await ended(await start());
    const before = await readDraft(kdb, threatModel);
    // Every attempt returns an answer that is not in the shape.
    stub.setFallback(respond(() => answered({ elements: 'nope' })));
    const failing = await start();
    const job = await ended(failing);
    expect(job).toMatchObject({ state: 'failed', failure: { category: 'invalid_output' } });
    expect(await readDraft(kdb, threatModel)).toEqual(before);
  });

  it('keeps the draft as it was when the new extraction is cancelled', async () => {
    await seedDesign();
    await startWorkerNow();
    await ended(await start());
    const before = await readDraft(kdb, threatModel);
    stub.setFallback((r) => (r.path.endsWith('/embeddings') ? embedded(r) : 'hang'));
    const running = await start();
    await waitFor(async () => ((await getJob(kdb, running))?.state === 'running' && generationRequests(stub).length === 2 ? true : undefined), 15_000, 'the second request');
    await cancelJob(kdb, running, alice);
    expect((await ended(running)).state).toBe('cancelled');
    expect(await readDraft(kdb, threatModel)).toEqual(before);
  });
});

describe('an answer that is not valid (FR-030 to FR-035)', () => {
  it('asks again, naming the problem by its path, and stores the answer that is right', async () => {
    await seedDesign();
    const wrong = validAnswer();
    wrong.elements[3]!.citations[0]!.quote = 'a passage that is nowhere in the documents';
    stub.setFallback(respond());
    stub.enqueue(answered(wrong), answered());
    const id = await start();
    await startWorkerNow();
    expect((await ended(id)).state).toBe('succeeded');
    const requests = generationRequests(stub);
    expect(requests).toHaveLength(2);
    const retry = messages(requests[1] as RecordedRequest).find((m) => m.role === 'user')?.content ?? '';
    expect(retry).toContain('elements.3.citations.0.quote: is not in the cited chunk');
    expect(retry).not.toContain('a passage that is nowhere');
    expect((await getDetail(kdb, id))?.usage.map((u) => u.attempts)).toEqual([2]);
    expect(await readDraft(kdb, threatModel)).toBeDefined();
  });

  it('fails as invalid output after three attempts, storing nothing', async () => {
    await seedDesign();
    const wrong = validAnswer();
    wrong.elements[0]!.citations[0]!.chunk = 'c9';
    stub.setFallback(respond(() => answered(wrong)));
    const id = await start();
    await startWorkerNow();
    const job = await ended(id);
    expect(job).toMatchObject({ state: 'failed', failure: { category: 'invalid_output' } });
    expect(generationRequests(stub)).toHaveLength(3);
    expect(await countOf('drafts')).toBe(0);
    expect(await countOf('draft_items')).toBe(0);
    // The settings the retry rules compare are kept with the failure.
    expect((await getDetail(kdb, id))?.extraction).toMatchObject({ context_chars: 36_000, max_output_tokens: 12_000 });
  });

  it('fails at once, with one request, when the answer was cut off at the output limit (FR-045)', async () => {
    await seedDesign();
    stub.setFallback(respond(() => openaiCompletion({ finish_reason: 'length', content: '{"elements":[', usage })));
    const id = await start();
    await startWorkerNow();
    expect(await ended(id)).toMatchObject({ state: 'failed', failure: { category: 'output_limit_reached' } });
    expect(generationRequests(stub)).toHaveLength(1);
    expect(await countOf('drafts')).toBe(0);
  });

  it('fails as input too large, with the hint to lower the budget, when the model refuses the input (FR-016)', async () => {
    await seedDesign();
    stub.setFallback(respond(() => openaiError(400, 'This input is longer than the model accepts.', { code: 'context_length_exceeded' })));
    const id = await start();
    await startWorkerNow();
    const job = await ended(id);
    expect(job).toMatchObject({ state: 'failed', failure: { category: 'input_too_large' } });
    expect(job.failure?.hint).toContain('EXTRACTION_CONTEXT_CHARS');
    expect(await countOf('drafts')).toBe(0);
  });
});

describe('a worker that loses the job (FR-051, SC-006)', () => {
  it('writes nothing, and another worker makes the draft once', async () => {
    await seedDesign();
    let first = true;
    stub.setFallback(
      respond(() => {
        if (first) {
          first = false;
          // The first worker’s request is still unanswered when the worker is gone.
          return { delay: 60_000, then: answered() };
        }
        return answered();
      }),
    );
    const id = await start();
    const lost = await startWorkerNow();
    await waitFor(() => generationRequests(stub)[0], 10_000, 'the request of the first worker');
    // It is gone as a crashed one is: nothing more is written, and its lease is left to run out.
    await lost.abandon();
    worker = undefined;
    expect(await countOf('drafts')).toBe(0);

    // Another worker finds the lease run out and queues the job again, after the wait a lost run is given; the test does not wait.
    await startWorkerNow();
    await waitFor(async () => {
      const job = await getJob(kdb, id);
      return job?.state === 'queued' && job.run === 1 ? true : undefined;
    }, 30_000, 'the lost run to be given up');
    await db.query('UPDATE jobs SET next_run_at = now() WHERE id = $1', [id]);
    expect((await ended(id)).state).toBe('succeeded');
    expect((await getJob(kdb, id))?.run).toBe(2);
    expect(await countOf('drafts')).toBe(1);
    expect(await countOf('draft_items')).toBe(11);

    // Left alone, nothing changes: the lost worker’s request does not come back to write a second draft.
    await sleep(600);
    expect(await countOf('drafts')).toBe(1);
    expect(await countOf('draft_items')).toBe(11);
  }, 60_000);
});

describe('sources that change (FR-044, FR-051, FR-053)', () => {
  it('fails at once as "no ready source" when there is none when the job runs, and does not ask the model', async () => {
    await seedUnreadySource(alice, threatModel, 'failed');
    const id = await start();
    await startWorkerNow();
    expect(await ended(id)).toMatchObject({ state: 'failed', failure: { category: 'no_ready_source' } });
    expect(generationRequests(stub)).toHaveLength(0);
  });

  it('runs again, reading what is there now, when a source it read is deleted before the draft is stored', async () => {
    await seedDesign();
    const doomed = await seedReadySource(alice, threatModel, { name: 'extra.md', chunks: ['An extra document that the answer does not cite.'] });
    let deleted = false;
    stub.setFallback(
      respond(() => {
        if (!deleted) {
          deleted = true;
          // The source goes while the model is answering, so that the draft would cite a source that is no longer there.
          void db.query('DELETE FROM sources WHERE id = $1', [doomed.sourceId]);
          return { delay: 300, then: answered() };
        }
        return answered();
      }),
    );
    const id = await start();
    await startWorkerNow();
    const first = await waitFor(async () => {
      // One read: the state and the run must be of the same moment.
      const job = await getJob(kdb, id);
      return job?.state === 'queued' && job.run === 1 ? true : undefined;
    }, 30_000, 'the first run to end');
    expect(first).toBe(true);
    expect(await countOf('drafts')).toBe(0);
    // A failure that may pass waits before its next run; the test does not.
    await db.query('UPDATE jobs SET next_run_at = now() WHERE id = $1', [id]);
    const second = await ended(id).catch(async (error: unknown) => {
      const { rows } = await db.query('SELECT state, run, max_runs, failure_category, next_run_at, now() AS now FROM jobs WHERE id = $1', [id]);
      throw new Error(`${(error as Error).message}: ${JSON.stringify(rows[0])} requests=${generationRequests(stub).length}`);
    });
    expect(second.state).toBe('succeeded');
    const draft = await readDraft(kdb, threatModel);
    expect(draft?.sources.map((s) => s.name)).toEqual(['design.md']);
    expect(draft?.sources_changed).toBe(false);
    expect(generationRequests(stub)).toHaveLength(2);
  }, 60_000);

  it('says its sources changed when one is added while the model answers (FR-053)', async () => {
    await seedDesign();
    let added = false;
    stub.setFallback(
      respond(() => {
        if (!added) {
          added = true;
          void seedReadySource(alice, threatModel, { name: 'late.md', chunks: ['A document added during the extraction.'] });
          return { delay: 300, then: answered() };
        }
        return answered();
      }),
    );
    const id = await start();
    await startWorkerNow();
    expect((await ended(id)).state).toBe('succeeded');
    await sleep(50);
    const draft = await readDraft(kdb, threatModel);
    expect(draft?.sources.map((s) => s.name)).toEqual(['design.md']);
    expect(draft?.sources_changed).toBe(true);
  });

  it('writes nothing when its threat model is deleted while the model answers', async () => {
    await seedDesign();
    stub.setFallback(respond(() => ({ delay: 300, then: answered() })));
    const id = await start();
    await startWorkerNow();
    await waitFor(() => (generationRequests(stub).length > 0 ? true : undefined), 15_000, 'the request');
    await db.query('DELETE FROM threat_models WHERE id = $1', [threatModel]);
    await sleep(600);
    expect(await countOf('drafts')).toBe(0);
    expect(await getJob(kdb, id)).toBeUndefined();
  });
});
