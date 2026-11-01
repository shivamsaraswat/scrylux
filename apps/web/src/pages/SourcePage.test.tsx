import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_ID, MODEL_ID, SOURCE_ID, chunk, failedSource, installFakeApi, json, jobsStatus, readySource, renderApp, source, sourceList, threatModel, project } from '../test-utils.js';

// One source (Phase 3 Milestone 3, US3, contracts/ui.md): what Scrylux read from a document, its chunks in order with where each came
// from, and nothing from the document is ever read as markup (FR-066).

afterEach(() => {
  vi.unstubAllGlobals();
});

const PAGE = `/threat-models/${MODEL_ID}/sources/${SOURCE_ID}`;
// A ready source whose facts differ from the default in the fields given.
const readyWith = (ready: { pages_without_text?: number | null; state?: string }) =>
  readySource({
    ready: {
      at: '2026-11-01T10:05:00.000Z',
      text_chars: 4000,
      chunk_count: 3,
      pages_without_text: ready.pages_without_text ?? null,
      embedding: { model: 'nomic-embed-text', dimension: 768, state: ready.state ?? 'current' },
    },
  });
const chunkId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function handlers(over: { source?: unknown; chunks?: (offset: number, limit: number) => { chunks: unknown[]; has_more: boolean } } = {}) {
  return {
    'GET /api/v1/threat-models/:id': () => json(200, threatModel()),
    'GET /api/v1/projects/:id': () => json(200, project()),
    'GET /api/v1/sources/:id': () => json(200, over.source ?? readySource()),
    'GET /api/v1/sources/:id/chunks': ({ query }: { query: URLSearchParams }) =>
      json(200, (over.chunks ?? (() => ({ chunks: [chunk()], has_more: false })))(Number(query.get('offset')), Number(query.get('limit')))),
  };
}

describe('the facts', () => {
  it('shows the name, type, size, who added it, when, and that it is ready with its chunks and text', async () => {
    installFakeApi(handlers({ source: readySource({ name: 'architecture.md', size_bytes: 1536 }) }));
    renderApp(PAGE);
    expect(await screen.findByRole('heading', { level: 1, name: 'architecture.md' })).toBeTruthy();
    const text = document.querySelector('dl')?.textContent ?? '';
    expect(text).toContain('Markdown');
    expect(text).toContain('1.5 KB');
    expect(text).toContain('ada');
    expect(text).toContain('3 chunks');
    expect(text).toContain('4000 characters');
    expect(text).toContain('nomic-embed-text');
  });

  it('says how many pages of a PDF had no text, and none when all had', async () => {
    installFakeApi(handlers({ source: { ...readyWith({ pages_without_text: 2 }), type: 'pdf' } }));
    renderApp(PAGE);
    expect(await screen.findByText('2 pages without text')).toBeTruthy();
  });

  it('does not mention pages without text for a file that has none', async () => {
    installFakeApi(handlers());
    renderApp(PAGE);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/without text/)).toBeNull();
  });

  it.each([
    ['current', 'Current'],
    ['out_of_date', 'Out of date'],
    ['no_provider', 'No embedding provider is configured'],
  ])('says the embeddings are %s', async (state, words) => {
    installFakeApi(handlers({ source: readyWith({ state }) }));
    renderApp(PAGE);
    expect(await screen.findByText(words)).toBeTruthy();
  });

  it('links back to the Sources tab', async () => {
    installFakeApi(handlers());
    renderApp(PAGE);
    const back = await screen.findByRole('link', { name: 'All documents' });
    expect(back.getAttribute('href')).toBe(`/threat-models/${MODEL_ID}/sources`);
  });
});

describe('the chunks', () => {
  it('shows each chunk with its number, its lines or pages, its heading and its text, in order', async () => {
    installFakeApi(
      handlers({
        chunks: () => ({
          chunks: [
            chunk({ id: chunkId(1), position: 0, text: 'First part.', heading: 'Intro', lines: { first: 1, last: 4 }, pages: null }),
            chunk({ id: chunkId(2), position: 1, text: 'Second part.', heading: null, lines: null, pages: { first: 2, last: 3 } }),
            chunk({ id: chunkId(3), position: 2, text: 'Third part.', lines: { first: 9, last: 9 }, pages: null }),
          ],
          has_more: false,
        }),
      }),
    );
    renderApp(PAGE);
    const items = await screen.findAllByRole('listitem', { name: /^Chunk \d+$/ });
    expect(items.map((item) => within(item).getByRole('heading').textContent)).toEqual(['Chunk 1', 'Chunk 2', 'Chunk 3']);
    expect(items[0]!.textContent).toContain('Lines 1–4');
    expect(items[0]!.textContent).toContain('Intro');
    expect(items[0]!.textContent).toContain('First part.');
    expect(items[1]!.textContent).toContain('Pages 2–3');
    expect(items[2]!.textContent).toContain('Line 9');
    expect(items[1]!.textContent).not.toContain('Intro');
  });

  it('shows only the first 50, and "Show more" loads the next 50 and goes away at the end', async () => {
    const all = Array.from({ length: 70 }, (_, i) => chunk({ id: chunkId(i + 1), position: i, text: `part ${i}`, start_offset: i * 10, end_offset: i * 10 + 6 }));
    const api = installFakeApi(handlers({ chunks: (offset, limit) => ({ chunks: all.slice(offset, offset + limit), has_more: offset + limit < all.length }) }));
    renderApp(PAGE);
    await screen.findByText('part 0');
    expect(screen.getAllByRole('listitem', { name: /^Chunk \d+$/ })).toHaveLength(50);
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('part 69');
    expect(screen.getAllByRole('listitem', { name: /^Chunk \d+$/ })).toHaveLength(70);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    expect(api.callsTo('GET', /chunks$/).map((call) => call.path)).toHaveLength(2);
  });

  it('renders text with markup, scripts and Markdown as text, keeping its line breaks (FR-066)', async () => {
    const hostile = '<script>alert(1)</script>\n<img src=x onerror=alert(2)>\n# not a heading\n**not bold**\n  indented';
    installFakeApi(handlers({ chunks: () => ({ chunks: [chunk({ id: CHUNK_ID, text: hostile, heading: '<b>bold</b>' })], has_more: false }) }));
    renderApp(PAGE);
    const block = await screen.findByText((_, el) => el?.tagName === 'PRE' && el.textContent === hostile);
    expect(block.textContent).toBe(hostile);
    expect(document.querySelector('script, img')).toBeNull();
    expect(document.querySelector('strong, b')).toBeNull();
    expect(screen.getByText('<b>bold</b>')).toBeTruthy();
  });

  it('shows the name of a document as text too', async () => {
    installFakeApi(handlers({ source: readySource({ name: '<img src=x onerror=alert(1)>.md' }) }));
    renderApp(PAGE);
    expect(await screen.findByRole('heading', { level: 1, name: '<img src=x onerror=alert(1)>.md' })).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('a source that is not ready', () => {
  it('says it is waiting, and asks for no chunks', async () => {
    const api = installFakeApi(handlers({ source: source() }));
    renderApp(PAGE);
    expect(await screen.findByText(/not ready yet/)).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(api.callsTo('GET', /chunks$/)).toHaveLength(0);
  });

  it('says it failed, with the message and the hint, and asks for no chunks', async () => {
    const api = installFakeApi(handlers({ source: failedSource() }));
    renderApp(PAGE);
    expect(await screen.findByText('This file could not be opened.')).toBeTruthy();
    expect(screen.getByText('Open it in the program that made it and save a fresh copy.')).toBeTruthy();
    expect(api.callsTo('GET', /chunks$/)).toHaveLength(0);
  });
});

describe('a source that is not there', () => {
  it('shows the not-found page for a source the server does not know', async () => {
    installFakeApi({ ...handlers(), 'GET /api/v1/sources/:id': () => json(404, { error: 'Source not found.' }) });
    renderApp(PAGE);
    expect(await screen.findByText(/doesn’t exist|doesn't exist/)).toBeTruthy();
  });

  it('shows the not-found page for an id that is not one, without asking the server', async () => {
    const api = installFakeApi(handlers());
    renderApp(`/threat-models/${MODEL_ID}/sources/nope`);
    expect(await screen.findByText(/doesn’t exist|doesn't exist/)).toBeTruthy();
    expect(api.callsTo('GET', /\/sources\//)).toHaveLength(0);
  });

  it('shows the not-found page for a source that belongs to another threat model', async () => {
    installFakeApi(handlers({ source: readySource({ threat_model_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }) }));
    renderApp(PAGE);
    expect(await screen.findByText(/doesn’t exist|doesn't exist/)).toBeTruthy();
  });
});

describe('deleting', () => {
  it('asks, deletes, and goes back to the list of documents', async () => {
    const api = installFakeApi({
      ...handlers({ source: readySource({ name: 'architecture.md' }) }),
      'DELETE /api/v1/sources/:id': () => json(204),
      'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList([])),
      'GET /api/v1/jobs/status': () => json(200, jobsStatus()),
    });
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete architecture.md? Its text and chunks are removed.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No documents yet.')).toBeTruthy();
    expect(api.callsTo('DELETE', `/api/v1/sources/${SOURCE_ID}`)).toHaveLength(1);
  });

  it('stays on the page, with the server’s words, when the deletion is refused', async () => {
    installFakeApi({ ...handlers(), 'DELETE /api/v1/sources/:id': () => json(500, { error: 'Something went wrong on the server.' }) });
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });
});

describe('keeping embeddings in step with the model (FR-034)', () => {
  const stale = (over: Record<string, unknown> = {}) => ({ ...readyWith({ state: 'out_of_date' }), refreshable: true, ...over });

  it('offers Refresh embeddings when the embeddings are out of date and can be refreshed', async () => {
    const api = installFakeApi({
      ...handlers({ source: stale() }),
      'POST /api/v1/sources/:id/refresh': () => json(200, { ...stale(), refreshable: false, refresh: { state: 'queued', progress: null } }),
    });
    renderApp(PAGE);
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh embeddings' }));
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/sources/${SOURCE_ID}/refresh`)).toHaveLength(1));
  });

  it('offers no refresh when the embeddings are current', async () => {
    installFakeApi(handlers());
    renderApp(PAGE);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Refresh embeddings' })).toBeNull();
  });

  it('shows the refresh in progress, and keeps the chunks readable meanwhile', async () => {
    installFakeApi(handlers({ source: stale({ refreshable: false, refresh: { state: 'running', progress: { step: 'embed', done: 3, total: 9 } } }) }));
    renderApp(PAGE);
    expect(await screen.findByText(/Refreshing/)).toBeTruthy();
    expect(await screen.findByText('The gateway forwards each request.')).toBeTruthy();
  });

  it('shows the last refresh failure with Retry, and the retry is asked for', async () => {
    const failure = { category: 'provider_unavailable', message: 'The embedding provider is unavailable.', hint: 'Try again later.', retryable: true };
    const api = installFakeApi({
      ...handlers({ source: stale({ refresh_failure: failure }) }),
      'POST /api/v1/sources/:id/retry': () => json(200, stale()),
    });
    renderApp(PAGE);
    expect(await screen.findByText('The embedding provider is unavailable.')).toBeTruthy();
    expect(screen.getByText('Try again later.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/sources/${SOURCE_ID}/retry`)).toHaveLength(1));
  });
});
