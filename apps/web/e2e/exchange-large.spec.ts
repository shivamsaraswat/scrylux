import { IMPORT_MAX_BYTES } from '@scrylux/core';
import { busiest, seed } from './bound.js';
import { apiToken, expect, seedModel, test } from './fixtures.js';

// Phase 2 / Milestone 6, FR-021 and SC-006, against the built app and a real database (quickstart §5): export, check and
// import stay quick on a typical threat model and at the size Milestone 3 allows (1,000 elements, about 15,000 threats
// and 49,000 mitigations), and the app answers other requests while a large import runs. This is a regression guard on a
// shared runner. The per-stage times and the memory are measured in process by exchange-bound.test.ts, and the
// authoritative figures are taken against `docker compose` and recorded in quickstart §5:
//   PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm --filter @scrylux/web test:e2e exchange-large

const SECONDS = 1000;
const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

interface Api {
  get(path: string): Promise<{ status: number; text: string; ms: number }>;
  post(path: string, body: string): Promise<{ status: number; text: string; ms: number }>;
}

function apiOf(base: string, token: string): Api {
  const send = async (method: string, path: string, body?: string) => {
    const started = Date.now();
    const res = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - started };
  };
  return { get: (path) => send('GET', path), post: (path, body) => send('POST', path, body) };
}

function record(label: string, what: string, ms: number, bytes?: number): void {
  const description = `${ms} ms${bytes === undefined ? '' : `, ${megabytes(bytes)}`}`;
  console.log(`exchange, ${label}, ${what}: ${description}`);
  test.info().annotations.push({ type: `${label} ${what}`, description });
}

test('exports, checks and imports a typical threat model each within 5 seconds (SC-006)', async ({ baseURL }) => {
  test.setTimeout(120 * SECONDS);
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const api = apiOf(base, token);
  const { modelId } = await seed(base, token, 'exchange-typical', 50, 'process', {});
  const { projectId } = await seedModel(base, token, 'exchange-typical-target');

  let scrylux = '';
  for (const format of ['scrylux', 'otm'] as const) {
    const exported = await api.get(`/api/v1/threat-models/${modelId}/export?format=${format}`);
    expect(exported.status).toBe(200);
    record('typical', `export ${format}`, exported.ms, exported.text.length);
    expect(exported.ms, `export ${format} took ${exported.ms} ms`).toBeLessThanOrEqual(5 * SECONDS);
    if (format === 'scrylux') scrylux = exported.text;
  }
  const body = JSON.stringify({ format: 'scrylux', file: JSON.parse(scrylux) as unknown });
  const check = await api.post(`/api/v1/projects/${projectId}/imports/check`, body);
  expect(check.status).toBe(200);
  record('typical', 'check', check.ms);
  expect(check.ms).toBeLessThanOrEqual(5 * SECONDS);
  const imported = await api.post(`/api/v1/projects/${projectId}/imports`, body);
  expect(imported.status).toBe(201);
  record('typical', 'import', imported.ms);
  expect(imported.ms).toBeLessThanOrEqual(5 * SECONDS);
});

test('exports, checks and imports the largest threat model each within 60 seconds, and the app keeps answering (FR-021, SC-006)', async ({ baseURL }) => {
  // Seeding is not timed, and takes far longer than Playwright's 30 s default.
  test.setTimeout(400 * SECONDS);
  const base = baseURL ?? '';
  const token = await apiToken(base);
  const api = apiOf(base, token);
  const { type, flags, candidates } = busiest();
  const { modelId, created } = await seed(base, token, 'exchange-large', 1000, type, flags);
  // The load is the one claimed: every element has the most threats the library gives any.
  expect(created).toBe(1000 * candidates);
  const { projectId } = await seedModel(base, token, 'exchange-large-target');

  let scrylux = '';
  for (const format of ['scrylux', 'otm'] as const) {
    const exported = await api.get(`/api/v1/threat-models/${modelId}/export?format=${format}`);
    expect(exported.status).toBe(200);
    record('large', `export ${format}`, exported.ms, exported.text.length);
    expect(exported.ms, `export ${format} took ${exported.ms} ms`).toBeLessThanOrEqual(60 * SECONDS);
    if (format === 'scrylux') scrylux = exported.text;
  }
  // The size limit leaves room: the largest model's Scrylux file is under two thirds of it (research #14).
  expect(scrylux.length).toBeLessThan(IMPORT_MAX_BYTES / 1.5);

  const body = JSON.stringify({ format: 'scrylux', file: JSON.parse(scrylux) as unknown });
  const check = await api.post(`/api/v1/projects/${projectId}/imports/check`, body);
  expect(check.status).toBe(200);
  record('large', 'check', check.ms, body.length);
  expect(check.ms).toBeLessThanOrEqual(60 * SECONDS);

  // While the import runs, another request is answered. The slowest answer is what a user would feel.
  const running = api.post(`/api/v1/projects/${projectId}/imports`, body);
  let slowest = 0;
  let done = false;
  void running.finally(() => (done = true));
  while (!done) {
    const answer = await api.get('/api/v1/projects');
    expect(answer.status).toBe(200);
    slowest = Math.max(slowest, answer.ms);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const imported = await running;
  expect(imported.status).toBe(201);
  record('large', 'import', imported.ms);
  record('large', 'slowest other request during the import', slowest);
  expect(imported.ms).toBeLessThanOrEqual(60 * SECONDS);
  expect(slowest, `another request waited ${slowest} ms for the import`).toBeLessThanOrEqual(2 * SECONDS);
});
