import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { appRoutes } from './App.js';
import { clearAccessToken } from './api/session.js';

// Shared by the page tests: a fake API behind `fetch`, and the app's real routes in a memory data
// router with a signed-in session. Not a test file, so Vitest doesn't collect it.

export function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FakeCall {
  method: string;
  path: string;
  body: unknown;
  // An upload is multipart form data, not JSON (Phase 3 Milestone 3).
  form: FormData | undefined;
}

interface FakeContext {
  params: Record<string, string>;
  body: unknown;
  form: FormData | undefined;
  query: URLSearchParams;
}

// "GET /api/v1/projects/:id" => handler. A handler may return a Promise, to hold a response open.
type FakeHandlers = Record<string, (context: FakeContext) => Response | Promise<Response>>;

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function compile(pattern: string): { method: string; regex: RegExp; names: string[] } {
  const [method = 'GET', path = ''] = pattern.split(' ');
  const names: string[] = [];
  const source = path.replace(/:([a-zA-Z]+)/g, (_match, name: string) => {
    names.push(name);
    return '([^/?]+)';
  });
  return { method, regex: new RegExp(`^${source}$`), names };
}

const SESSION = {
  access_token: 'test-token',
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  account: { id: 7, username: 'ada' },
};

// Installs the fake API as the global `fetch`. A signed-in session is answered by default. Any request
// without a handler fails the test, so a page can't quietly call an endpoint the test didn't expect.
export function installFakeApi(handlers: FakeHandlers = {}) {
  const calls: FakeCall[] = [];
  const compiled = Object.entries(handlers).map(([pattern, handler]) => ({ ...compile(pattern), handler }));
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(urlOf(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const form = init?.body instanceof FormData ? init.body : undefined;
    if (url.pathname === '/api/session/refresh' && !compiled.some((c) => c.regex.test('/api/session/refresh'))) {
      return json(200, SESSION);
    }
    calls.push({ method, path: url.pathname, body, form });
    for (const route of compiled) {
      const match = route.regex.exec(url.pathname);
      if (match && route.method === method) {
        const params = Object.fromEntries(route.names.map((name, i) => [name, match[i + 1] ?? '']));
        return route.handler({ params, body, form, query: url.searchParams });
      }
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  clearAccessToken();
  return { calls, fetchMock, callsTo: (method: string, path: RegExp | string) => calls.filter((c) => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path))) };
}

export function renderApp(route: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter(appRoutes, { initialEntries: [route] })} />
    </QueryClientProvider>,
  );
}

// A component on its own, inside a query client, for tests of components that fetch and write.
export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

export const THREAT_ID = '55555555-5555-4555-8555-555555555555';
export const THREAT_ID_2 = '66666666-6666-4666-8666-666666666666';
export const ELEMENT_ID = '77777777-7777-4777-8777-777777777777';
export const MITIGATION_ID = '88888888-8888-4888-8888-888888888888';
export const MITIGATION_ID_2 = '99999999-9999-4999-8999-999999999999';

export const threat = (overrides: Record<string, unknown> = {}) => ({
  id: THREAT_ID,
  threat_model_id: MODEL_ID,
  element_id: null,
  category: 'Spoofing',
  title: 'Session token theft',
  description: 'A stolen token is replayed',
  likelihood: 'High',
  impact: 'High',
  risk: 'Critical',
  status: 'open',
  origin: 'manual',
  library_ref: null,
  stale: null,
  status_reason: null,
  created_at: '2026-10-03T10:00:00.000Z',
  updated_at: '2026-10-03T10:00:00.000Z',
  ...overrides,
});

export const mitigation = (overrides: Record<string, unknown> = {}) => ({
  id: MITIGATION_ID,
  threat_id: THREAT_ID,
  description: 'Rotate refresh credentials',
  status: 'proposed',
  external_ref: null,
  created_at: '2026-10-03T11:00:00.000Z',
  updated_at: '2026-10-03T11:00:00.000Z',
  ...overrides,
});

export const element = (overrides: Record<string, unknown> = {}) => ({
  id: ELEMENT_ID,
  threat_model_id: MODEL_ID,
  type: 'process',
  name: 'API gateway',
  properties: {},
  layout: null,
  source_element_id: null,
  target_element_id: null,
  parent_boundary_id: null,
  created_at: '2026-10-03T09:00:00.000Z',
  updated_at: '2026-10-03T09:00:00.000Z',
  ...overrides,
});

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
export const PROJECT_ID_2 = '22222222-2222-4222-8222-222222222222';
export const MODEL_ID = '33333333-3333-4333-8333-333333333333';
export const MODEL_ID_2 = '44444444-4444-4444-8444-444444444444';

export const project = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  name: 'Payments',
  description: 'Card payments',
  created_by: 7,
  created_at: '2026-10-01T10:00:00.000Z',
  updated_at: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

export const threatModel = (overrides: Record<string, unknown> = {}) => ({
  id: MODEL_ID,
  project_id: PROJECT_ID,
  name: 'Checkout v2',
  methodology: 'STRIDE',
  status: 'draft',
  created_at: '2026-10-02T10:00:00.000Z',
  updated_at: '2026-10-02T10:00:00.000Z',
  ...overrides,
});

export const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const JOB_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const jobTotals = (overrides: Record<string, unknown> = {}) => ({
  requests: 0,
  input_tokens: 0,
  output_tokens: 0,
  tokens_estimated: false,
  cost_usd: 0,
  cost_known_usd: 0,
  cost_estimated: false,
  cost_cap_applied: true,
  duration_ms: 0,
  ...overrides,
});

// A job as the API sends it (JobRecord): queued, started by the signed-in account, with no usage yet.
export const job = (overrides: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  kind: 'provider_check',
  state: 'queued',
  started_by: { id: 7, username: 'ada' },
  cancelled_by: null,
  cancel_requested: false,
  worker_lost: false,
  queued_at: '2026-11-01T10:00:00.000Z',
  started_at: null,
  finished_at: null,
  next_run_at: null,
  deadline_at: null,
  run: 0,
  max_runs: 3,
  caps: { tokens: 500000, cost_usd: 5 },
  progress: null,
  failure: null,
  totals: jobTotals(),
  threat_model_id: null,
  source_id: null,
  ...overrides,
});

// A job with its usage records and result (JobDetail). `ingestion` is what an ingestion kept of its run, and `extraction` what an
// extraction kept of its run: counts only.
export const jobDetail = (overrides: Record<string, unknown> = {}) => ({ ...job(), usage: [], result: null, ingestion: null, extraction: null, ...overrides });

export const jobsStatus = (overrides: Record<string, unknown> = {}) => ({
  worker_alive: true,
  ai: { generation: { provider: 'openai-compatible', model: 'llama3.2', hosted: false }, embedding: null },
  provider_check: { offered: true, next_allowed_at: null },
  ...overrides,
});

// ---- sources (Phase 3 Milestone 3) ----

export const SOURCE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const SOURCE_ID_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const CHUNK_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// A source as the API sends it (SourceRecord): just added, waiting for the worker.
export const source = (overrides: Record<string, unknown> = {}) => ({
  id: SOURCE_ID,
  threat_model_id: MODEL_ID,
  name: 'design.md',
  type: 'md',
  size_bytes: 1200,
  added_by: { id: 7, username: 'ada' },
  added_at: '2026-11-01T10:00:00.000Z',
  status: 'waiting',
  progress: null,
  failure: null,
  ready: null,
  refresh: null,
  refresh_failure: null,
  refreshable: false,
  ...overrides,
});

export const readySource = (overrides: Record<string, unknown> = {}) =>
  source({
    status: 'ready',
    ready: { at: '2026-11-01T10:05:00.000Z', text_chars: 4000, chunk_count: 3, pages_without_text: null, embedding: { model: 'nomic-embed-text', dimension: 768, state: 'current' } },
    ...overrides,
  });

/** A ready source whose embeddings are in this state ('current', 'out_of_date' or 'no_provider'). */
export const readySourceWith = (state: string, overrides: Record<string, unknown> = {}) =>
  source({
    status: 'ready',
    ready: { at: '2026-11-01T10:05:00.000Z', text_chars: 4000, chunk_count: 3, pages_without_text: null, embedding: { model: 'nomic-embed-text', dimension: 768, state } },
    ...overrides,
  });

export const failedSource = (failure: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) =>
  source({ status: 'failed', failure: { category: 'damaged', message: 'This file could not be opened.', hint: 'Open it in the program that made it and save a fresh copy.', retryable: false, ...failure }, ...overrides });

export const sourceList = (sources: unknown[] = [], limits: Record<string, unknown> = {}) => ({
  sources,
  limits: { max_bytes: 10 * 1024 * 1024, per_threat_model: 20, used_bytes: 0, document_space_bytes: 2 * 1024 ** 3, ...limits },
});

export const chunk = (overrides: Record<string, unknown> = {}) => ({
  id: CHUNK_ID,
  position: 0,
  start_offset: 0,
  end_offset: 35,
  text: 'The gateway forwards each request.',
  pages: null,
  lines: { first: 1, last: 1 },
  heading: null,
  ...overrides,
});

// ---- extraction and the draft (Phase 3 Milestone 4) ----

export const DRAFT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const DRAFT_API_ID = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
export const DRAFT_DB_ID = 'a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a2a2';
export const DRAFT_FLOW_ID = 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3';
export const DRAFT_BOUNDARY_ID = 'a4a4a4a4-a4a4-44a4-84a4-a4a4a4a4a4a4';
export const DRAFT_ASSET_ID = 'a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5';
export const DRAFT_ASSUMPTION_ID = 'a6a6a6a6-a6a6-46a6-86a6-a6a6a6a6a6a6';

/** A chunk a citation points at: where in which source it is. */
export const citedChunk = (overrides: Record<string, unknown> = {}) => ({
  id: CHUNK_ID,
  source_id: SOURCE_ID,
  source_name: 'design.md',
  position: 3,
  page_first: null,
  page_last: null,
  line_first: 10,
  line_last: 24,
  heading: 'Architecture',
  ...overrides,
});

export const citation = (overrides: Record<string, unknown> = {}) => ({ chunk: citedChunk(), quote: 'The API is exposed to the internet', ...overrides });

/** A small draft: a boundary holding a database, an API, a flow between them, an asset and an assumption. */
export const draftRecord = (overrides: Record<string, unknown> = {}) => ({
  id: DRAFT_ID,
  threat_model_id: MODEL_ID,
  made_at: '2026-11-08T10:00:00.000Z',
  started_by: { id: 7, username: 'ada' },
  job_id: JOB_ID,
  generation_model: 'claude-test',
  prompt_version: 'extract-system/0123456789ab',
  path: 'whole',
  chunks_read: 18,
  chunks_available: 18,
  sources: [
    { id: SOURCE_ID, name: 'design.md', read: true },
    { id: SOURCE_ID_2, name: 'notes.txt', read: true },
    { id: 'abababab-abab-4bab-8bab-abababababab', name: 'ops.md', read: true },
  ],
  sources_deleted: 0,
  sources_changed: false,
  nothing_found: null,
  elements: [
    {
      id: DRAFT_API_ID,
      type: 'process',
      name: 'API',
      boundary_id: null,
      source_id: null,
      target_id: null,
      flags: [{ flag: 'internet_facing', value: true, citations: [citation()] }],
      rationale: 'The API serves the web application.',
      citations: [citation()],
    },
    {
      id: DRAFT_DB_ID,
      type: 'data_store',
      name: 'Database',
      boundary_id: DRAFT_BOUNDARY_ID,
      source_id: null,
      target_id: null,
      flags: [],
      rationale: 'Threats are kept in a database.',
      citations: [citation({ quote: 'stores threats in a PostgreSQL database' })],
    },
    {
      id: DRAFT_FLOW_ID,
      type: 'data_flow',
      name: 'Threat data',
      boundary_id: null,
      source_id: DRAFT_API_ID,
      target_id: DRAFT_DB_ID,
      flags: [],
      rationale: 'The API reads and writes threats.',
      citations: [citation()],
    },
    {
      id: DRAFT_BOUNDARY_ID,
      type: 'trust_boundary',
      name: 'Private network',
      boundary_id: null,
      source_id: null,
      target_id: null,
      flags: [],
      rationale: 'The database is on a private network.',
      citations: [citation({ quote: 'runs in a private network' })],
    },
  ],
  assets: [{ id: DRAFT_ASSET_ID, name: 'Threat data', description: 'The threats the application stores.', held_by: [DRAFT_DB_ID], rationale: 'The database holds them.', citations: [citation()] }],
  assumptions: [{ id: DRAFT_ASSUMPTION_ID, statement: 'The network keeps outsiders away from the database.', rationale: 'The design relies on it.', citations: [citation()] }],
  read_chunks: [{ source_id: SOURCE_ID, position: 0 }],
  ...overrides,
});

export const extractionStatus = (overrides: Record<string, unknown> = {}) => ({
  latest: null,
  start: { offered: true, path: 'whole', replaces_draft: false },
  chunks_available: 18,
  budget_chars: 36000,
  ...overrides,
});

export const notOffered = (reason: string, message: string, source_ids: string[] = []) => ({ offered: false, reason, message, source_ids });
