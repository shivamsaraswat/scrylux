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
}

interface FakeContext {
  params: Record<string, string>;
  body: unknown;
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
    if (url.pathname === '/api/session/refresh' && !compiled.some((c) => c.regex.test('/api/session/refresh'))) {
      return json(200, SESSION);
    }
    calls.push({ method, path: url.pathname, body });
    for (const route of compiled) {
      const match = route.regex.exec(url.pathname);
      if (match && route.method === method) {
        const params = Object.fromEntries(route.names.map((name, i) => [name, match[i + 1] ?? '']));
        return route.handler({ params, body, query: url.searchParams });
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
  ...overrides,
});

// A job with its usage records and result (JobDetail).
export const jobDetail = (overrides: Record<string, unknown> = {}) => ({ ...job(), usage: [], result: null, ...overrides });

export const jobsStatus = (overrides: Record<string, unknown> = {}) => ({
  worker_alive: true,
  ai: { generation: { provider: 'openai-compatible', model: 'llama3.2', hosted: false }, embedding: null },
  provider_check: { offered: true, next_allowed_at: null },
  ...overrides,
});
