import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_ID, installFakeApi, jobDetail, json, renderApp } from '../test-utils.js';

// One job (Phase 3 Milestone 2, contracts/ui.md; spec US1, FR-015, FR-061, FR-064, FR-066).

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const open = (detail: Record<string, unknown>) => {
  const api = installFakeApi({ [`GET /api/v1/jobs/${JOB_ID}`]: () => json(200, jobDetail(detail)) });
  renderApp(`/jobs/${JOB_ID}`);
  return api;
};

describe('JobPage: the header', () => {
  it('shows the kind, the state, who started it and when it was queued, started and finished', async () => {
    open({
      state: 'succeeded',
      run: 1,
      queued_at: '2026-10-31T09:00:00.000Z',
      started_at: '2026-10-31T09:00:01.000Z',
      finished_at: '2026-10-31T09:00:03.000Z',
    });
    expect(await screen.findByRole('heading', { name: 'Provider check' })).toBeTruthy();
    expect(screen.getByText('Succeeded')).toBeTruthy();
    // The signed-in account is also named in the header.
    expect(screen.getAllByText('ada')).toHaveLength(2);
    expect(screen.getByText(new Date('2026-10-31T09:00:00.000Z').toLocaleString())).toBeTruthy();
    expect(screen.getByText(new Date('2026-10-31T09:00:01.000Z').toLocaleString())).toBeTruthy();
    expect(screen.getByText(new Date('2026-10-31T09:00:03.000Z').toLocaleString())).toBeTruthy();
  });

  it('shows the time of the next run while a job waits for one', async () => {
    open({ state: 'queued', run: 1, next_run_at: '2026-11-01T10:05:00.000Z' });
    expect(await screen.findByText(new Date('2026-11-01T10:05:00.000Z').toLocaleString())).toBeTruthy();
    expect(screen.getByText(/Next run/)).toBeTruthy();
  });

  it('shows a queued job that has not run as queued, with no times it does not have', async () => {
    open({ state: 'queued' });
    expect(await screen.findByText('Queued')).toBeTruthy();
    expect(screen.queryByText(/Finished/)).toBeNull();
  });
});

describe('JobPage: progress (FR-015)', () => {
  it.each([
    ['generation', 'Checking generation'],
    ['embeddings', 'Checking embeddings'],
  ])('names the step %s', async (step, text) => {
    open({ state: 'running', run: 1, progress: { step } });
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('says how much of a step is done where it is known', async () => {
    open({ state: 'running', run: 1, progress: { step: 'embeddings', done: 2, total: 5 } });
    expect(await screen.findByText(/2 of 5/)).toBeTruthy();
  });
});

describe('JobPage: a failure (FR-064)', () => {
  it('shows the message and the hint, and the category in words', async () => {
    open({
      state: 'failed',
      run: 1,
      finished_at: '2026-11-01T10:00:03.000Z',
      failure: { category: 'not_authorized', message: 'The provider did not accept the credentials.', hint: 'Check LLM_API_KEY, and that the key may use this model.' },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The provider did not accept the credentials.');
    expect(alert.textContent).toContain('Check LLM_API_KEY');
    expect(alert.textContent).toContain('not authorized');
  });

  it('shows text from the API as text, never as markup (FR-066)', async () => {
    open({
      state: 'failed',
      run: 1,
      finished_at: '2026-11-01T10:00:03.000Z',
      started_by: { id: 9, username: '<script>alert(1)</script>' },
      failure: { category: 'job_error', message: '<b>bold</b>', hint: '<img src=x onerror=alert(1)>' },
    });
    expect(await screen.findByText('<b>bold</b>')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.body.querySelector('b, img, script')).toBeNull();
  });
});

describe('JobPage: caps, runs and usage (FR-043, FR-050)', () => {
  const usageRow = (over: Record<string, unknown> = {}) => ({
    id: 1, run: 1, operation: 'generate', provider: 'openai-compatible', model: 'llama3.2', outcome: 'ok', attempts: 1, input_tokens: 64,
    output_tokens: 9, tokens_estimated: false, cost_usd: 0.0021, cost_estimated: false, price_source: 'operator', temperature_applied: true,
    duration_ms: 1800, recorded_at: '2026-11-01T10:00:02.000Z', ...over,
  });

  it('shows the runs used of the most, and the caps', async () => {
    open({ state: 'running', run: 2, max_runs: 3, caps: { tokens: 500000, cost_usd: 5 } });
    expect(await screen.findByText('2 of 3')).toBeTruthy();
    expect(screen.getByText(/500000 tokens/).textContent).toContain('$5');
  });

  it('shows the totals: tokens in and out, and the cost', async () => {
    open({
      state: 'succeeded', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      totals: { requests: 2, input_tokens: 73, output_tokens: 9, tokens_estimated: false, cost_usd: 0.0021, cost_known_usd: 0.0021, cost_estimated: false, cost_cap_applied: true, duration_ms: 1900 },
      usage: [usageRow()],
    });
    expect(await screen.findByText('73 in, 9 out')).toBeTruthy();
    expect(screen.getAllByText('$0.0021').length).toBeGreaterThan(0);
    expect(screen.queryByText(/cost cap could not be applied/)).toBeNull();
  });

  it('says when any count was estimated', async () => {
    open({
      state: 'succeeded', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      totals: { requests: 1, input_tokens: 10, output_tokens: 5, tokens_estimated: true, cost_usd: 0.001, cost_known_usd: 0.001, cost_estimated: true, cost_cap_applied: true, duration_ms: 100 },
      usage: [usageRow({ tokens_estimated: true })],
    });
    expect(await screen.findByText('10 in, 5 out (estimated)')).toBeTruthy();
  });

  it('says the cost is unknown with the least it cost, and that the cost cap could not be applied, never zero (FR-043)', async () => {
    open({
      state: 'succeeded', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      totals: { requests: 2, input_tokens: 70, output_tokens: 9, tokens_estimated: false, cost_usd: null, cost_known_usd: 0.001, cost_estimated: false, cost_cap_applied: false, duration_ms: 1900 },
      usage: [usageRow({ cost_usd: 0.001 }), usageRow({ id: 2, operation: 'embed', cost_usd: null, price_source: 'none', output_tokens: 0, temperature_applied: null })],
    });
    expect(await screen.findByText('cost unknown (at least $0.001)')).toBeTruthy();
    expect(screen.getByText(/The cost cap could not be applied to every request/)).toBeTruthy();
  });

  it('lists each request: the operation, the model, the outcome, its tokens and its cost', async () => {
    open({
      state: 'succeeded', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      totals: { requests: 2, input_tokens: 73, output_tokens: 9, tokens_estimated: false, cost_usd: null, cost_known_usd: 0.0021, cost_estimated: false, cost_cap_applied: false, duration_ms: 1900 },
      usage: [usageRow(), usageRow({ id: 2, operation: 'embed', model: 'nomic-embed-text', input_tokens: 9, output_tokens: 0, cost_usd: null, price_source: 'none', temperature_applied: null })],
    });
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Generation')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('openai-compatible / llama3.2')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('64 in, 9 out')).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText('$0.0021')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('Embeddings')).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText('cost unknown')).toBeTruthy();
  });

  it('shows no usage table for a job that has made no request', async () => {
    open({ state: 'queued' });
    await screen.findByText('Queued');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the message of a cap that is lower than one request (FR-044)', async () => {
    open({
      state: 'failed', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      failure: { category: 'cap_reached', message: 'The job’s cap is lower than one request to this model needs, so nothing was sent.', hint: 'An operator can raise JOB_TOKEN_CAP or JOB_COST_CAP.' },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('lower than one request');
    expect(screen.getByRole('alert').textContent).toContain('JOB_COST_CAP');
  });
});

describe('JobPage: the result of a provider check (FR-091, FR-092)', () => {
  const usage = (id: number, over: Record<string, unknown> = {}) => ({
    id, run: 1, operation: 'generate', provider: 'anthropic', model: 'claude-haiku-5-5', outcome: 'ok', attempts: 1, input_tokens: 64, output_tokens: 9,
    tokens_estimated: false, cost_usd: 0.0021, cost_estimated: false, price_source: 'list', temperature_applied: true, duration_ms: 900,
    recorded_at: '2026-11-01T10:00:02.000Z', ...over,
  });
  const finished = { state: 'succeeded', run: 1, finished_at: '2026-11-01T10:00:03.000Z' };

  it('shows one block for each operation: the provider, the model, where its data goes, how it ended and what it used', async () => {
    open({
      ...finished,
      usage: [usage(1), usage(2, { operation: 'embed', provider: 'openai-compatible', model: 'nomic-embed-text', input_tokens: 9, output_tokens: 0, cost_usd: null, price_source: 'none', temperature_applied: null })],
      result: {
        generation: { status: 'ok', provider: 'anthropic', model: 'claude-haiku-5-5', hosted: true, usage_id: 1 },
        embeddings: { status: 'ok', provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false, usage_id: 2 },
      },
    });
    const generation = await screen.findByRole('region', { name: 'Generation' });
    expect(within(generation).getByText('Worked')).toBeTruthy();
    expect(within(generation).getByText('anthropic, model claude-haiku-5-5')).toBeTruthy();
    expect(within(generation).getByText('Hosted: data sent to it leaves this install')).toBeTruthy();
    expect(within(generation).getByText('64 in, 9 out, $0.0021')).toBeTruthy();

    const embeddings = screen.getByRole('region', { name: 'Embeddings' });
    expect(within(embeddings).getByText('Worked')).toBeTruthy();
    expect(within(embeddings).getByText('Local: data sent to it stays in this install')).toBeTruthy();
    expect(within(embeddings).getByText('9 in, 0 out, cost unknown')).toBeTruthy();
  });

  it('shows a failed operation with its message and hint, and the one that worked beside it', async () => {
    open({
      state: 'failed', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      failure: { category: 'not_authorized', message: 'The provider did not accept the credentials.', hint: 'Check LLM_API_KEY.' },
      usage: [usage(1, { outcome: 'not_authorized' }), usage(2, { operation: 'embed', provider: 'openai-compatible', model: 'nomic-embed-text' })],
      result: {
        generation: { status: 'not_authorized', provider: 'anthropic', model: 'claude-haiku-5-5', hosted: true, usage_id: 1, message: 'The provider did not accept the credentials.', hint: 'Check LLM_API_KEY.' },
        embeddings: { status: 'ok', provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false, usage_id: 2 },
      },
    });
    const generation = await screen.findByRole('region', { name: 'Generation' });
    expect(within(generation).getByText('Failed: not authorized')).toBeTruthy();
    expect(within(generation).getByText('The provider did not accept the credentials.')).toBeTruthy();
    expect(within(generation).getByText('Check LLM_API_KEY.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Embeddings' })).getByText('Worked')).toBeTruthy();
  });

  it('says an operation is not configured, and that one the job never reached was not run', async () => {
    open({
      ...finished,
      result: { generation: { status: 'ok', provider: 'anthropic', model: 'm', hosted: true }, embeddings: { status: 'not_configured' } },
    });
    expect(within(await screen.findByRole('region', { name: 'Embeddings' })).getByText('Not configured')).toBeTruthy();
  });

  it('says an operation the job never reached was not run, with no provider named for it', async () => {
    open({
      state: 'failed', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      failure: { category: 'cap_reached', message: 'The job stopped.', hint: 'Raise the cap.' },
      result: { generation: { status: 'not_run' }, embeddings: { status: 'not_run' } },
    });
    const generation = await screen.findByRole('region', { name: 'Generation' });
    expect(within(generation).getByText('Not run: the job stopped before this step')).toBeTruthy();
    expect(within(generation).queryByText(/model/)).toBeNull();
  });

  it('says an abandoned request was cancelled, or timed out', async () => {
    open({
      state: 'cancelled', run: 1, finished_at: '2026-11-01T10:00:03.000Z', cancelled_by: { id: 8, username: 'grace' },
      usage: [usage(1, { outcome: 'cancelled' })],
      result: {
        generation: { status: 'cancelled', provider: 'anthropic', model: 'claude-haiku-5-5', hosted: true, usage_id: 1, message: 'The request was cancelled.', hint: 'The request was stopped before it finished. Nothing is wrong with the provider.' },
        embeddings: { status: 'not_run' },
      },
    });
    const generation = await screen.findByRole('region', { name: 'Generation' });
    // A request a person stopped did not fail, and says so (US3 scenario 5).
    expect(within(generation).getByText('Cancelled')).toBeTruthy();
    expect(within(generation).queryByText(/Failed/)).toBeNull();
    expect(within(generation).getByText('The request was stopped before it finished. Nothing is wrong with the provider.')).toBeTruthy();
  });

  it('shows no result for a job that has none yet, and renders what the API sends as text', async () => {
    open({ state: 'queued' });
    await screen.findByText('Queued');
    expect(screen.queryByRole('region', { name: 'Generation' })).toBeNull();
  });

  it('never turns a message into markup (FR-066)', async () => {
    open({
      state: 'failed', run: 1, finished_at: '2026-11-01T10:00:03.000Z',
      failure: { category: 'refused', message: 'm', hint: 'h' },
      result: {
        generation: { status: 'refused', provider: 'anthropic', model: '<img src=x onerror=alert(1)>', hosted: true, message: '<b>bold</b>', hint: '<script>alert(1)</script>' },
        embeddings: { status: 'not_configured' },
      },
    });
    const generation = await screen.findByRole('region', { name: 'Generation' });
    expect(within(generation).getByText('<b>bold</b>')).toBeTruthy();
    expect(document.body.querySelector('img, script, b')).toBeNull();
  });
});

describe('JobPage: cancelling (FR-030, FR-032)', () => {
  const CANCEL_PATH = `/api/v1/jobs/${JOB_ID}/cancel`;

  it.each(['queued', 'running'])('offers Cancel for a %s job, and asks first', async (state) => {
    const api = installFakeApi({
      [`GET /api/v1/jobs/${JOB_ID}`]: () => json(200, jobDetail({ state, run: 1 })),
      [`POST ${CANCEL_PATH}`]: () => json(200, jobDetail({ state: 'cancelled', finished_at: '2026-11-01T10:00:09.000Z', cancelled_by: { id: 7, username: 'ada' } })),
    });
    renderApp(`/jobs/${JOB_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel job' }));
    // Nothing is sent until the dialog is confirmed.
    expect(api.callsTo('POST', CANCEL_PATH)).toHaveLength(0);
    expect(screen.getByText(/stops as soon as it can/i)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel the job' }));
    await waitFor(() => expect(api.callsTo('POST', CANCEL_PATH)).toHaveLength(1));
  });

  it('sends nothing when the question is answered with Keep running', async () => {
    const api = installFakeApi({ [`GET /api/v1/jobs/${JOB_ID}`]: () => json(200, jobDetail({ state: 'queued' })) });
    renderApp(`/jobs/${JOB_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel job' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(api.callsTo('POST', CANCEL_PATH)).toHaveLength(0);
    expect(screen.queryByText(/stops as soon as it can/i)).toBeNull();
  });

  it('says Cancelling… while a cancel is asked and the job still runs, and offers no second Cancel', async () => {
    installFakeApi({ [`GET /api/v1/jobs/${JOB_ID}`]: () => json(200, jobDetail({ state: 'running', run: 1, cancel_requested: true, cancelled_by: { id: 8, username: 'grace' }, progress: { step: 'generation' } })) });
    renderApp(`/jobs/${JOB_ID}`);
    expect(await screen.findAllByText('Cancelling…')).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Cancel job' })).toBeNull();
  });

  it('shows who cancelled a job and when', async () => {
    installFakeApi({
      [`GET /api/v1/jobs/${JOB_ID}`]: () =>
        json(200, jobDetail({ state: 'cancelled', run: 1, finished_at: '2026-11-01T10:00:09.000Z', cancelled_by: { id: 8, username: 'grace' } })),
    });
    renderApp(`/jobs/${JOB_ID}`);
    expect(await screen.findByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('grace')).toBeTruthy();
    expect(screen.getByText(new Date('2026-11-01T10:00:09.000Z').toLocaleString())).toBeTruthy();
  });

  it.each(['succeeded', 'failed', 'cancelled'])('offers no Cancel for a job that has %s', async (state) => {
    installFakeApi({
      [`GET /api/v1/jobs/${JOB_ID}`]: () =>
        json(200, jobDetail({ state, run: 1, finished_at: '2026-11-01T10:00:09.000Z', ...(state === 'failed' ? { failure: { category: 'job_error', message: 'm', hint: 'h' } } : {}) })),
    });
    renderApp(`/jobs/${JOB_ID}`);
    await screen.findByRole('heading', { name: 'Provider check' });
    expect(screen.queryByRole('button', { name: 'Cancel job' })).toBeNull();
  });

  it('shows the server’s message when the job had already finished (409), and reads the job again', async () => {
    let finished = false;
    const api = installFakeApi({
      [`GET /api/v1/jobs/${JOB_ID}`]: () => json(200, finished ? jobDetail({ state: 'succeeded', run: 1, finished_at: '2026-11-01T10:00:09.000Z' }) : jobDetail({ state: 'running', run: 1 })),
      [`POST ${CANCEL_PATH}`]: () => {
        finished = true;
        return json(409, { error: 'The job has already finished' });
      },
    });
    renderApp(`/jobs/${JOB_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel job' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the job' }));
    expect((await screen.findByText('The job has already finished', { selector: 'p' })).textContent).toBe('The job has already finished');
    expect(await screen.findByText('Succeeded')).toBeTruthy();
    expect(api.callsTo('GET', `/api/v1/jobs/${JOB_ID}`).length).toBeGreaterThan(1);
  });

  it('cancels a job whose worker was lost, with the lost-worker text beside the button', async () => {
    installFakeApi({ [`GET /api/v1/jobs/${JOB_ID}`]: () => json(200, jobDetail({ state: 'running', run: 1, worker_lost: true })) });
    renderApp(`/jobs/${JOB_ID}`);
    expect(await screen.findByRole('button', { name: 'Cancel job' })).toBeTruthy();
    expect(screen.getByText(/cancel it to end it now/)).toBeTruthy();
  });
});

describe('JobPage: a job whose worker was lost (FR-062)', () => {
  it('says so, and what happens next', async () => {
    open({ state: 'running', run: 1, worker_lost: true, progress: { step: 'generation' } });
    expect(await screen.findByText(/Its worker was lost/)).toBeTruthy();
    expect(screen.getByText(/cancel it to end it now/)).toBeTruthy();
  });
});

describe('JobPage: refreshing (FR-061)', () => {
  it('asks again every 2 seconds while the job is queued or running, and stops once it has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state = 'running';
    let reads = 0;
    installFakeApi({
      [`GET /api/v1/jobs/${JOB_ID}`]: () => {
        reads++;
        return json(200, jobDetail({ state, run: 1, ...(state === 'running' ? { progress: { step: 'generation' } } : { finished_at: '2026-11-01T10:00:05.000Z' }) }));
      },
    });
    renderApp(`/jobs/${JOB_ID}`);
    await screen.findByText('Running');

    const before = reads;
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads).toBe(before + 1);

    state = 'succeeded';
    await vi.advanceTimersByTimeAsync(2100);
    await screen.findByText('Succeeded');
    const settled = reads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(settled);
  });

  it('does not ask again for a job that had already ended when the page opened', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    installFakeApi({
      [`GET /api/v1/jobs/${JOB_ID}`]: () => {
        reads++;
        return json(200, jobDetail({ state: 'failed', run: 1, finished_at: '2026-11-01T10:00:05.000Z', failure: { category: 'job_error', message: 'm', hint: 'h' } }));
      },
    });
    renderApp(`/jobs/${JOB_ID}`);
    await screen.findByText('Failed');
    const settled = reads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(settled);
  });
});

describe('JobPage: a job that is not there', () => {
  it('shows the app’s not-found page for a 404', async () => {
    installFakeApi({ [`GET /api/v1/jobs/${JOB_ID}`]: () => json(404, { error: 'Job not found' }) });
    renderApp(`/jobs/${JOB_ID}`);
    expect(await screen.findByRole('heading', { name: /This page doesn.t exist/ })).toBeTruthy();
  });

  it('shows the not-found page for an id that is not one, without asking the API', async () => {
    const api = installFakeApi({});
    renderApp('/jobs/not-an-id');
    expect(await screen.findByRole('heading', { name: /This page doesn.t exist/ })).toBeTruthy();
    expect(api.callsTo('GET', /\/api\/v1\/jobs\//)).toHaveLength(0);
  });

  it('shows the server message and a Retry button for any other failure', async () => {
    installFakeApi({ [`GET /api/v1/jobs/${JOB_ID}`]: () => json(500, { error: 'Internal server error' }) });
    renderApp(`/jobs/${JOB_ID}`);
    expect(await screen.findByText('Internal server error')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
