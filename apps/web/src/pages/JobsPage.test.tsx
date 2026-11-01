import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_ID, JOB_ID_2, MODEL_ID, SOURCE_ID, installFakeApi, job, jobTotals, jobsStatus, json, renderApp } from '../test-utils.js';

// The Jobs page (Phase 3 Milestone 2, contracts/ui.md; spec FR-047, FR-061, FR-061a, FR-062, FR-063, FR-066): whether AI is
// configured and where its data goes, the check, and every job newest first.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const list = (jobs: unknown[], hasMore = false) => json(200, { jobs, has_more: hasMore });

describe('JobsPage: the AI status', () => {
  it('says each operation is not configured, or its provider, model and where data goes (FR-044)', async () => {
    installFakeApi({
      'GET /api/v1/jobs/status': () =>
        json(200, jobsStatus({ ai: { generation: { provider: 'anthropic', model: 'claude-haiku-5-5', hosted: true }, embedding: { provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false } } })),
      'GET /api/v1/jobs': () => list([]),
    });
    renderApp('/jobs');
    const generation = await screen.findByText(/Generation:/);
    expect(generation.textContent).toContain('anthropic');
    expect(generation.textContent).toContain('claude-haiku-5-5');
    expect(generation.textContent).toContain('data sent to it leaves this install');
    const embeddings = screen.getByText(/Embeddings:/);
    expect(embeddings.textContent).toContain('nomic-embed-text');
    expect(embeddings.textContent).toContain('stays in this install');
  });

  it('says embeddings are not configured when they are not', async () => {
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => list([]) });
    renderApp('/jobs');
    expect((await screen.findByText(/Embeddings:/)).textContent).toContain('not configured');
  });
});

describe('JobsPage: Check AI provider (FR-063, FR-047)', () => {
  it('starts a provider check with no input, and shows the job at once', async () => {
    let jobs: unknown[] = [];
    const api = installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
      'GET /api/v1/jobs': () => list(jobs),
      'POST /api/v1/jobs': () => {
        jobs = [job()];
        return json(201, job());
      },
    });
    renderApp('/jobs');
    await userEvent.click(await screen.findByRole('button', { name: 'Check AI provider' }));
    expect(api.callsTo('POST', '/api/v1/jobs')[0]?.body).toEqual({ kind: 'provider_check', input: {} });
    const row = await screen.findByRole('link', { name: 'Provider check' });
    expect(row.getAttribute('href')).toBe(`/jobs/${JOB_ID}`);
  });

  it('is not offered when AI is not configured, and says so (FR-063)', async () => {
    installFakeApi({
      'GET /api/v1/jobs/status': () =>
        json(200, jobsStatus({ ai: { generation: null, embedding: null }, provider_check: { offered: false, next_allowed_at: null } })),
      'GET /api/v1/jobs': () => list([]),
    });
    renderApp('/jobs');
    expect(await screen.findByText(/AI is not configured on this install/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check AI provider' })).toBeNull();
  });

  it('is disabled with the time of the next check while the cooldown runs (FR-047)', async () => {
    const next = new Date(Date.now() + 240_000).toISOString();
    installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus({ provider_check: { offered: true, next_allowed_at: next } })),
      'GET /api/v1/jobs': () => list([]),
    });
    renderApp('/jobs');
    const button = await screen.findByRole('button', { name: 'Check AI provider' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/next provider check/i).textContent).toContain(new Date(next).toLocaleTimeString());
  });

  it('shows the server’s message when a start is refused (409, 429)', async () => {
    installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
      'GET /api/v1/jobs': () => list([]),
      'POST /api/v1/jobs': () => json(429, { error: 'You already have 3 jobs queued or running. Wait for one to finish, or cancel one.' }),
    });
    renderApp('/jobs');
    await userEvent.click(await screen.findByRole('button', { name: 'Check AI provider' }));
    expect((await screen.findByRole('alert')).textContent).toContain('You already have 3 jobs queued or running');
  });
});

describe('JobsPage: the list (FR-061, FR-061a)', () => {
  const finished = job({
    id: JOB_ID_2,
    state: 'succeeded',
    run: 1,
    queued_at: '2026-10-31T09:00:00.000Z',
    started_at: '2026-10-31T09:00:01.000Z',
    finished_at: '2026-10-31T09:00:03.000Z',
    totals: jobTotals({ requests: 2, input_tokens: 73, output_tokens: 9, cost_usd: 0.0021, cost_known_usd: 0.0021 }),
  });

  it('lists the jobs in the API’s order with kind, state, starter, queued time and a link each', async () => {
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => list([job(), finished]) });
    renderApp('/jobs');
    const links = await screen.findAllByRole('link', { name: 'Provider check' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([`/jobs/${JOB_ID}`, `/jobs/${JOB_ID_2}`]);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0] as HTMLElement).getByText('Queued')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Succeeded')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('ada')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(new Date('2026-10-31T09:00:00.000Z').toLocaleString())).toBeTruthy();
  });

  it('shows the step of a running job, and the tokens and cost of a finished one', async () => {
    const running = job({ state: 'running', run: 1, progress: { step: 'generation' } });
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => list([running, finished]) });
    renderApp('/jobs');
    expect(await screen.findByText('Checking generation')).toBeTruthy();
    expect(screen.getByText(/73 in, 9 out/)).toBeTruthy();
    expect(screen.getByText('$0.0021')).toBeTruthy();
  });

  it('says the cost of a job is unknown rather than showing zero (FR-043)', async () => {
    const unknown = job({ id: JOB_ID_2, state: 'succeeded', run: 1, totals: jobTotals({ requests: 1, input_tokens: 5, output_tokens: 5, cost_usd: null, cost_cap_applied: false }) });
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => list([unknown]) });
    renderApp('/jobs');
    expect(await screen.findByText('cost unknown')).toBeTruthy();
  });

  it('marks a job that is being cancelled, and one whose worker was lost', async () => {
    const cancelling = job({ state: 'running', run: 1, cancel_requested: true, progress: { step: 'generation' } });
    const lost = job({ id: JOB_ID_2, state: 'running', run: 1, worker_lost: true, progress: { step: 'embeddings' } });
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => list([cancelling, lost]) });
    renderApp('/jobs');
    expect(await screen.findByText('Cancelling…')).toBeTruthy();
    expect(screen.getByText('Worker lost')).toBeTruthy();
    expect(screen.queryByText('Checking embeddings')).toBeNull();
  });

  it('shows the empty state', async () => {
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => list([]) });
    renderApp('/jobs');
    expect(await screen.findByText('No jobs yet.')).toBeTruthy();
  });

  it('shows more, a page at a time, while the API says there is more', async () => {
    const calls: string[] = [];
    installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
      'GET /api/v1/jobs': ({ query }) => {
        calls.push(`${query.get('limit')}/${query.get('offset')}`);
        return query.get('offset') === '0' ? list([finished], true) : list([job({ id: JOB_ID, state: 'succeeded', run: 1 })], false);
      },
    });
    renderApp('/jobs');
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Provider check' })).toHaveLength(2));
    expect(calls).toContain('25/0');
    expect(calls).toContain('25/1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows the server message and a Retry button when the list cannot be loaded', async () => {
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => json(500, { error: 'Internal server error' }) });
    renderApp('/jobs');
    expect(await screen.findByText('Internal server error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows what the API sends as text, never as markup (FR-066)', async () => {
    const hostile = job({ started_by: { id: 9, username: '<img src=x onerror=alert(1)>' } });
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus()), 'GET /api/v1/jobs': () => list([hostile]) });
    const { container } = renderApp('/jobs');
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('JobsPage: the no-worker notice (FR-062)', () => {
  const NOTICE = /No worker is processing jobs/;

  it('shows when no worker is alive and a job is queued', async () => {
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus({ worker_alive: false })), 'GET /api/v1/jobs': () => list([job()]) });
    renderApp('/jobs');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });

  it('shows when a listed job has lost its worker', async () => {
    const lost = job({ state: 'running', run: 1, worker_lost: true });
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus({ worker_alive: false })), 'GET /api/v1/jobs': () => list([lost]) });
    renderApp('/jobs');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });

  it('shows when a listed job has lost its worker, though another worker is alive', async () => {
    const lost = job({ state: 'running', run: 1, worker_lost: true });
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus({ worker_alive: true })), 'GET /api/v1/jobs': () => list([lost]) });
    renderApp('/jobs');
    expect(await screen.findByText(NOTICE)).toBeTruthy();
  });

  it('does not show when a worker is alive, or when nothing is waiting', async () => {
    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus({ worker_alive: true })), 'GET /api/v1/jobs': () => list([job()]) });
    const first = renderApp('/jobs');
    await screen.findByRole('link', { name: 'Provider check' });
    expect(screen.queryByText(NOTICE)).toBeNull();
    first.unmount();

    installFakeApi({ 'GET /api/v1/jobs/status': () => json(200, jobsStatus({ worker_alive: false })), 'GET /api/v1/jobs': () => list([job({ state: 'succeeded', run: 1 })]) });
    renderApp('/jobs');
    await screen.findByRole('link', { name: 'Provider check' });
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});

describe('JobsPage: refreshing (FR-061)', () => {
  it('asks again every 2 seconds while a listed job is queued or running, and stops once all have ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state = 'running';
    let reads = 0;
    let statusReads = 0;
    installFakeApi({
      'GET /api/v1/jobs/status': () => {
        statusReads++;
        return json(200, jobsStatus());
      },
      'GET /api/v1/jobs': () => {
        reads++;
        return list([job({ state, run: 1, ...(state === 'running' ? {} : { finished_at: '2026-11-01T10:00:05.000Z' }) })]);
      },
    });
    renderApp('/jobs');
    await screen.findByText('Running');

    const before = reads;
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads).toBe(before + 2);
    expect(statusReads).toBeGreaterThanOrEqual(3);

    state = 'succeeded';
    await vi.advanceTimersByTimeAsync(2100);
    await screen.findByText('Succeeded');
    const settled = reads;
    const settledStatus = statusReads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(settled);
    expect(statusReads).toBe(settledStatus);
  });

  it('does not ask again when every listed job has already ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
      'GET /api/v1/jobs': () => {
        reads++;
        return list([job({ state: 'failed', run: 1 })]);
      },
    });
    renderApp('/jobs');
    await screen.findByText('Failed');
    const settled = reads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(settled);
  });
});


describe('JobsPage: the jobs of documents (Phase 3 Milestone 3)', () => {
  it('names the two kinds of ingestion in words a person reads, and links each to its page', async () => {
    installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
      'GET /api/v1/jobs': () =>
        list([
          job({ id: JOB_ID, kind: 'ingest_source', threat_model_id: MODEL_ID, source_id: SOURCE_ID }),
          job({ id: JOB_ID_2, kind: 'refresh_embeddings', threat_model_id: MODEL_ID, source_id: SOURCE_ID }),
        ]),
    });
    renderApp('/jobs');
    expect((await screen.findByRole('link', { name: 'Process a document' })).getAttribute('href')).toBe(`/jobs/${JOB_ID}`);
    expect(screen.getByRole('link', { name: 'Refresh embeddings' }).getAttribute('href')).toBe(`/jobs/${JOB_ID_2}`);
  });

  it('says which step a running ingestion is on, and how many chunks are done', async () => {
    installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
      'GET /api/v1/jobs': () =>
        list([
          job({ id: JOB_ID, kind: 'ingest_source', state: 'running', progress: { step: 'embed', done: 3, total: 10 } }),
          job({ id: JOB_ID_2, kind: 'ingest_source', state: 'running', progress: { step: 'extract' } }),
        ]),
    });
    renderApp('/jobs');
    expect(await screen.findByText('Embedding the chunks (3 of 10)')).toBeTruthy();
    expect(screen.getByText('Reading the document')).toBeTruthy();
  });

  it('shows what an ingestion used, as it shows what a provider check used', async () => {
    installFakeApi({
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
      'GET /api/v1/jobs': () => list([job({ kind: 'ingest_source', state: 'succeeded', totals: jobTotals({ requests: 3, input_tokens: 1200, cost_usd: 0.0004, cost_known_usd: 0.0004 }) })]),
    });
    renderApp('/jobs');
    expect(await screen.findByText('1200 in, 0 out')).toBeTruthy();
  });
});
