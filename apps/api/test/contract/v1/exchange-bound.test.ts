import { IMPORT_MAX_BYTES, ScryluxFileV1, checkBounds } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { parseFile } from '../../../src/exchange/import/parse.js';
import { checkPlan } from '../../../src/exchange/import/plan.js';
import { planScrylux } from '../../../src/exchange/import/scrylux.js';
import { runImport } from '../../../src/exchange/import/write.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { seedBound } from './exchange-helpers.js';
import { client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// Phase 2 / Milestone 6, FR-021 and SC-006 (quickstart §5): export, check and import at the largest threat model Milestone
// 3 allows, and at the size limit, measured in this process. The stages of the pipeline are timed one by one, and the
// process's memory is sampled while they run, because an import is built in the API process (research #14, #19). The
// figures are printed as one JSON line each, for quickstart §5 and the pull request; the only thing asserted is the
// time the success criterion sets.

const SECONDS = 1000;

// Runs `work`, sampling the process's resident memory every 50 ms. `peakMb` is the highest the process reached, which is
// what a small host must hold; `grewMb` is how far above where it began, which is less, because Node keeps what it has
// already grown and reuses it.
async function sampled<T>(work: () => Promise<T>): Promise<{ result: T; ms: number; peakMb: number; grewMb: number }> {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
  const started = performance.now();
  try {
    const result = await work();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { result, ms: Math.round(performance.now() - started), peakMb: Math.round(peak / 1_048_576), grewMb: Math.round((peak - baseline) / 1_048_576) };
  } finally {
    clearInterval(timer);
  }
}

const timed = <T>(work: () => T): { result: T; ms: number } => {
  const started = performance.now();
  const result = work();
  return { result, ms: Math.round(performance.now() - started) };
};

const report = (label: string, figures: Record<string, unknown>): void => console.log(JSON.stringify({ measured: 'exchange-bound', label, ...figures }));

describe('the largest threat model and the size limit (FR-021, SC-006)', () => {
  let server: TestServer;
  let c: V1Client;
  let modelId: string;
  let text: string;
  const newProject = async (): Promise<string> => (await c.post<ApiRecord>('/projects', { name: uniqueName('Target') })).body.id;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
    ({ modelId } = await seedBound(c));
  }, 600 * SECONDS);

  afterAll(async () => {
    await server.close();
  });

  it('exports both formats, checks and imports the Scrylux file, each within 60 seconds, and reports each stage', async () => {
    const exported = await Promise.all(
      (['scrylux', 'otm'] as const).map(async (format) => {
        const run = await sampled(async () => (await fetch(`${server.baseUrl}/api/v1/threat-models/${modelId}/export?format=${format}`, { headers: { Authorization: `Bearer ${await login(server.baseUrl)}` } })).text());
        return { format, ...run };
      }),
    );
    for (const { format, result, ms, peakMb, grewMb } of exported) {
      report('bound export', { format, ms, bytes: result.length, peakMb, grewMb });
      expect(ms).toBeLessThan(60 * SECONDS);
    }
    text = exported[0]?.result ?? '';
    expect(text.length).toBeLessThan(IMPORT_MAX_BYTES / 1.5);

    // The stages, one by one: this is where the time and the memory go.
    const parsed = timed(() => JSON.parse(text) as Record<string, unknown>);
    const bounds = timed(() => checkBounds(parsed.result));
    const schema = timed(() => parseFile('scrylux', parsed.result));
    const planned = timed(() => planScrylux(ScryluxFileV1.parse(parsed.result)));
    const checked = timed(() => checkPlan(planned.result, { existingNames: [] }));
    report('bound stages', { jsonParse: parsed.ms, checkBounds: bounds.ms, schema: schema.ms, plan: planned.ms, checkPlan: checked.ms });

    const body = JSON.stringify({ format: 'scrylux', file: parsed.result });
    const post = async (path: string): Promise<Response> =>
      fetch(`${server.baseUrl}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await login(server.baseUrl)}` }, body });
    const target = await newProject();
    const check = await sampled(() => post(`/projects/${target}/imports/check`));
    expect(check.result.status).toBe(200);
    report('bound check', { ms: check.ms, peakMb: check.peakMb, grewMb: check.grewMb, bodyBytes: body.length });
    expect(check.ms).toBeLessThan(60 * SECONDS);

    const imported = await sampled(() => post(`/projects/${target}/imports`));
    expect(imported.result.status).toBe(201);
    report('bound import', { ms: imported.ms, peakMb: imported.peakMb, grewMb: imported.grewMb });
    expect(imported.ms).toBeLessThan(60 * SECONDS);
    const write = await sampled(async () => runImport(await newProject(), planScrylux(ScryluxFileV1.parse(parsed.result)), ['Write timing']));
    report('bound write', { ms: write.ms, peakMb: write.peakMb, grewMb: write.grewMb });
  }, 600 * SECONDS);

  it('imports a file of exactly the size limit within 60 seconds, and reports its time and memory', async () => {
    const file = JSON.parse(text) as { threats: { description: string }[] };
    const wrapper = (): string => JSON.stringify({ format: 'scrylux', file });
    // Every threat's description is lengthened (at most 10,000 characters each) until the request body is exactly the
    // limit, which the parser accepts and one byte more it refuses.
    let missing = IMPORT_MAX_BYTES - wrapper().length;
    const perThreat = Math.min(9_000, Math.floor(missing / file.threats.length));
    for (const threat of file.threats) threat.description += 'x'.repeat(perThreat);
    missing = IMPORT_MAX_BYTES - wrapper().length;
    for (let at = 0; missing > 0; at += 1) {
      const add = Math.min(missing, 10_000 - (file.threats[at]?.description.length ?? 0));
      (file.threats[at] as { description: string }).description += 'y'.repeat(add);
      missing -= add;
    }
    const body = wrapper();
    expect(body.length).toBe(IMPORT_MAX_BYTES);
    const target = await newProject();
    const token = await login(server.baseUrl);
    const post = (path: string): Promise<Response> =>
      fetch(`${server.baseUrl}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body });
    const check = await sampled(() => post(`/projects/${target}/imports/check`));
    expect(check.result.status).toBe(200);
    report('limit check', { ms: check.ms, peakMb: check.peakMb, grewMb: check.grewMb, bodyBytes: body.length });
    const imported = await sampled(() => post(`/projects/${target}/imports`));
    expect(imported.result.status).toBe(201);
    report('limit import', { ms: imported.ms, peakMb: imported.peakMb, grewMb: imported.grewMb });
    expect(Math.max(check.ms, imported.ms)).toBeLessThan(60 * SECONDS);
  }, 900 * SECONDS);
});
