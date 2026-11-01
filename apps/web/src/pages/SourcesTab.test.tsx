import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_ID, SOURCE_ID, SOURCE_ID_2, failedSource, installFakeApi, json, jobsStatus, project, readySource, readySourceWith, renderApp, source, sourceList, threatModel } from '../test-utils.js';

// The Sources tab of a threat model (Phase 3 Milestone 3, contracts/ui.md; spec FR-004, FR-005, FR-030, FR-062 to FR-066): adding
// documents, the list with each one's status, and what a person is told when something is refused. The notice that data leaves
// the install is in SourcesNotice.test.tsx; deleting, retrying and refreshing are added with their own stories.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const EMBEDDING = { provider: 'openai-compatible', model: 'nomic-embed-text', hosted: false };

function handlers(over: { sources?: unknown[]; status?: Record<string, unknown>; limits?: Record<string, unknown> } = {}) {
  return {
    'GET /api/v1/threat-models/:id': () => json(200, threatModel()),
    'GET /api/v1/projects/:id': () => json(200, project()),
    'GET /api/v1/threat-models/:id/elements': () => json(200, []),
    'GET /api/v1/threat-models/:id/threats': () => json(200, []),
    'GET /api/v1/threat-models/:id/mitigations': () => json(200, []),
    'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(over.sources ?? [], over.limits)),
    'GET /api/v1/jobs/status': () => json(200, jobsStatus({ ai: { generation: null, embedding: EMBEDDING }, ...over.status })),
  };
}
const file = (name: string, size = 20, type = 'text/markdown') => new File([new Uint8Array(size).fill(97)], name, { type });
const chooser = async () => await screen.findByLabelText<HTMLInputElement>(/Files/);
const TAB = `/threat-models/${MODEL_ID}/sources`;

describe('the list', () => {
  it('says there are no documents yet', async () => {
    installFakeApi(handlers());
    renderApp(TAB);
    expect(await screen.findByText('No documents yet.')).toBeTruthy();
  });

  it('shows each source’s name, type, size, who added it and when', async () => {
    installFakeApi(handlers({ sources: [readySource({ name: 'architecture.md', size_bytes: 1536 })] }));
    renderApp(TAB);
    const row = (await screen.findByText('architecture.md')).closest('tr') as HTMLElement;
    expect(within(row).getByText('md')).toBeTruthy();
    expect(within(row).getByText('1.5 KB')).toBeTruthy();
    expect(within(row).getByText('ada')).toBeTruthy();
  });

  it('shows the status of each: waiting, processing with its step, ready with its chunks, failed with why', async () => {
    installFakeApi(
      handlers({
        sources: [
          source({ id: SOURCE_ID, name: 'one.md' }),
          source({ id: SOURCE_ID_2, name: 'two.md', status: 'processing', progress: { step: 'embed', done: 3, total: 10 } }),
          readySource({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', name: 'three.md' }),
          failedSource({}, { id: '12121212-1212-4212-8212-121212121212', name: 'four.pdf', type: 'pdf' }),
        ],
      }),
    );
    renderApp(TAB);
    const rowOf = async (name: string): Promise<HTMLElement> => (await screen.findByText(name)).closest('tr') as HTMLElement;
    expect((await rowOf('one.md')).textContent).toContain('Waiting');
    const two = (await rowOf('two.md')).textContent ?? '';
    expect(two).toContain('Processing');
    expect(two).toContain('Embedding the chunks (3 of 10)');
    const three = (await rowOf('three.md')).textContent ?? '';
    expect(three).toContain('Ready');
    expect(three).toContain('3 chunks');
    const four = (await rowOf('four.pdf')).textContent ?? '';
    expect(four).toContain('This file could not be opened.');
    expect(four).toContain('Open it in the program that made it and save a fresh copy.');
  });

  it('says how the embeddings of a ready source stand, when they are not the configured model’s (FR-033)', async () => {
    installFakeApi(handlers({ sources: [readySource({ name: 'old.md', ready: { at: '2026-11-01T10:05:00.000Z', text_chars: 4000, chunk_count: 3, pages_without_text: null, embedding: { model: 'old-model', dimension: 768, state: 'out_of_date' } } })] }));
    renderApp(TAB);
    expect(((await screen.findByText('old.md')).closest('tr') as HTMLElement).textContent).toMatch(/embeddings are out of date/i);
  });

  it('shows what the source’s name holds as text, never as markup (FR-066)', async () => {
    installFakeApi(handlers({ sources: [source({ name: '<script>alert(1)</script><b>bold</b>.md' })] }));
    const { container } = renderApp(TAB);
    expect(await screen.findByText('<script>alert(1)</script><b>bold</b>.md')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('tbody b')).toBeNull();
  });

  it('links a ready source to its page, where its chunks are, and no other', async () => {
    installFakeApi(handlers({ sources: [readySource({ name: 'ready.md' }), source({ id: SOURCE_ID_2, name: 'waiting.md' })] }));
    renderApp(TAB);
    expect((await screen.findByRole('link', { name: 'ready.md' })).getAttribute('href')).toBe(`${TAB}/${SOURCE_ID}`);
    expect(screen.queryByRole('link', { name: 'waiting.md' })).toBeNull();
  });

  it('says that no worker is processing documents when one waits and none is alive (FR-064)', async () => {
    installFakeApi(handlers({ sources: [source()], status: { worker_alive: false } }));
    renderApp(TAB);
    expect(await screen.findByText(/No worker is processing documents/)).toBeTruthy();
  });

  it('says nothing about a worker when one is alive, or when nothing is waiting', async () => {
    installFakeApi(handlers({ sources: [source()], status: { worker_alive: true } }));
    renderApp(TAB);
    await screen.findByText('design.md');
    expect(screen.queryByText(/No worker is processing documents/)).toBeNull();
  });
});

describe('polling (FR-063)', () => {
  it('reads the list again every two seconds while a source is waiting or processing, and stops when none is', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sources = [source()];
    const api = installFakeApi({ ...handlers(), 'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(sources)) });
    renderApp(TAB);
    await screen.findByText('design.md');
    const reads = () => api.callsTo('GET', `/api/v1/threat-models/${MODEL_ID}/sources`).length;
    const first = reads();
    await vi.advanceTimersByTimeAsync(2100);
    expect(reads()).toBeGreaterThan(first);

    sources = [readySource()];
    await vi.advanceTimersByTimeAsync(2100);
    await screen.findByText(/3 chunks/);
    const settled = reads();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads()).toBe(settled);
  });

  it('does not read at all while every source is ready or failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = installFakeApi(handlers({ sources: [readySource(), failedSource({}, { id: SOURCE_ID_2, name: 'x.pdf', type: 'pdf' })] }));
    renderApp(TAB);
    await screen.findByText('design.md');
    const first = api.callsTo('GET', `/api/v1/threat-models/${MODEL_ID}/sources`).length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(api.callsTo('GET', `/api/v1/threat-models/${MODEL_ID}/sources`).length).toBe(first);
  });
});

describe('adding documents', () => {
  it('shows no form, and says what is missing, when no embedding provider is configured (FR-030)', async () => {
    installFakeApi(handlers({ status: { ai: { generation: { provider: 'anthropic', model: 'claude-haiku-5-5', hosted: true }, embedding: null } } }));
    renderApp(TAB);
    expect(await screen.findByText('Adding documents needs an embedding provider. Ask the operator to set one up.')).toBeTruthy();
    expect(screen.queryByLabelText(/Files/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.queryByLabelText('Title')).toBeNull();
  });

  it('shows the form when one is configured, and accepts only the four kinds of file', async () => {
    installFakeApi(handlers());
    renderApp(TAB);
    const input = await chooser();
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('.md,.txt,.pdf,.docx');
  });

  it('sends the files one at a time, in the order chosen, and shows the result of each (FR-004)', async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sources: unknown[] = [];
    const api = installFakeApi({
      ...handlers(),
      'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(sources)),
      'POST /api/v1/threat-models/:id/sources': async ({ form }) => {
        const name = (form?.get('file') as File).name;
        if (name === 'one.md') await gate;
        sources = [...sources, source({ id: name === 'one.md' ? SOURCE_ID : SOURCE_ID_2, name })];
        return json(201, source({ name }));
      },
    });
    renderApp(TAB);
    await userEvent.upload(await chooser(), [file('one.md'), file('two.md')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));

    // The second file has not been sent while the first is still on its way.
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/sources`)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/sources`)).toHaveLength(1);
    releaseFirst();
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/sources`)).toHaveLength(2));
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/sources`).map((c) => (c.form?.get('file') as File).name)).toEqual(['one.md', 'two.md']);
    expect(await screen.findByText(/one\.md: added/)).toBeTruthy();
    expect(await screen.findByText(/two\.md: added/)).toBeTruthy();
  });

  it('refuses in the browser a file larger than the limit, with the same words as the server, and sends nothing for it (FR-004)', async () => {
    const api = installFakeApi({ ...handlers({ limits: { max_bytes: 1024 * 1024 } }), 'POST /api/v1/threat-models/:id/sources': () => json(201, source()) });
    renderApp(TAB);
    await userEvent.upload(await chooser(), [file('big.md', 1024 * 1024 + 1), file('small.md')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('big.md: The file is larger than 1 MB, the most allowed.')).toBeTruthy();
    await screen.findByText(/small\.md: added/);
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/sources`).map((c) => (c.form?.get('file') as File).name)).toEqual(['small.md']);
  });

  it.each([
    [409, 'This document is already a source of this threat model: first.md.'],
    [503, 'Scrylux is busy reading other uploads. Try again in a few seconds.'],
    [507, 'The document space of this install is full. Delete sources, or ask the operator to raise DOCUMENT_SPACE.'],
    [429, 'You already have 20 documents being processed. Wait for one to finish.'],
    [415, 'This file is not a PDF.'],
  ])('shows the server’s own words for a %i, not a generic message', async (status, error) => {
    installFakeApi({ ...handlers(), 'POST /api/v1/threat-models/:id/sources': () => json(status, { error }) });
    renderApp(TAB);
    await userEvent.upload(await chooser(), [file('design.md')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText(`design.md: ${error}`)).toBeTruthy();
  });

  it('keeps going with the next file when one is refused', async () => {
    const api = installFakeApi({
      ...handlers(),
      'POST /api/v1/threat-models/:id/sources': ({ form }) => ((form?.get('file') as File).name === 'bad.md' ? json(409, { error: 'Already there.' }) : json(201, source())),
    });
    renderApp(TAB);
    await userEvent.upload(await chooser(), [file('bad.md'), file('good.md')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('bad.md: Already there.')).toBeTruthy();
    expect(await screen.findByText(/good\.md: added/)).toBeTruthy();
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/sources`)).toHaveLength(2);
  });

  it('cannot be submitted with no file chosen, and is busy while it sends', async () => {
    installFakeApi({ ...handlers(), 'POST /api/v1/threat-models/:id/sources': () => new Promise<Response>(() => undefined) });
    renderApp(TAB);
    const button = await screen.findByRole('button', { name: 'Upload' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.upload(await chooser(), [file('design.md')]);
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(button);
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: /Uploading|Upload/ }).disabled).toBe(true));
  });

  it('puts the list up to date after an add, without a reload', async () => {
    let sources: unknown[] = [];
    installFakeApi({
      ...handlers(),
      'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(sources)),
      'POST /api/v1/threat-models/:id/sources': () => {
        sources = [source({ name: 'just-added.md' })];
        return json(201, source({ name: 'just-added.md' }));
      },
    });
    renderApp(TAB);
    await userEvent.upload(await chooser(), [file('just-added.md')]);
    await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByRole('cell', { name: 'just-added.md' })).toBeTruthy();
  });
});

describe('pasting text', () => {
  it('sends the title and the text as JSON and shows the source it made', async () => {
    let sources: unknown[] = [];
    const api = installFakeApi({
      ...handlers(),
      'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(sources)),
      'POST /api/v1/threat-models/:id/sources/text': ({ body }) => {
        sources = [source({ name: (body as { title: string }).title, type: 'text' })];
        return json(201, sources[0]);
      },
    });
    renderApp(TAB);
    await userEvent.type(await screen.findByLabelText('Title'), 'Architecture notes');
    await userEvent.type(screen.getByLabelText('Text'), 'The API talks to the database.');
    await userEvent.click(screen.getByRole('button', { name: 'Add text' }));
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/sources/text`)[0]?.body).toEqual({ title: 'Architecture notes', text: 'The API talks to the database.' }));
    expect(await screen.findByRole('cell', { name: 'Architecture notes' })).toBeTruthy();
  });

  it('cannot be submitted without both a title and a text', async () => {
    installFakeApi(handlers());
    renderApp(TAB);
    const add = await screen.findByRole<HTMLButtonElement>('button', { name: 'Add text' });
    expect(add.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Title'), 'Notes');
    expect(add.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Text'), 'x');
    expect(add.disabled).toBe(false);
  });

  it('shows the server’s words when the text is refused, and keeps what was typed', async () => {
    installFakeApi({ ...handlers(), 'POST /api/v1/threat-models/:id/sources/text': () => json(409, { error: 'This document is already a source of this threat model: notes.' }) });
    renderApp(TAB);
    await userEvent.type(await screen.findByLabelText('Title'), 'Again');
    await userEvent.type(screen.getByLabelText('Text'), 'same text');
    await userEvent.click(screen.getByRole('button', { name: 'Add text' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('This document is already a source of this threat model: notes.');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Text').value).toBe('same text');
  });
});

describe('the tab', () => {
  it('sits beside Threats and Diagram on the threat model page, and is a link to its own address', async () => {
    installFakeApi(handlers());
    renderApp(`/threat-models/${MODEL_ID}`);
    const nav = await screen.findByRole('navigation', { name: 'Threat model views' });
    expect(within(nav).getByRole('link', { name: 'Sources' }).getAttribute('href')).toBe(TAB);
  });
});

describe('deleting a document (FR-054)', () => {
  it('asks first, with the name, and does nothing on Cancel', async () => {
    const api = installFakeApi(handlers({ sources: [readySource({ name: 'architecture.md' })] }));
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete architecture.md' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete architecture.md? Its text and chunks are removed.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.callsTo('DELETE', /\/sources\//)).toHaveLength(0);
  });

  it('deletes after the answer, then reads the list again and the document is gone', async () => {
    let sources = [readySource({ name: 'architecture.md' }), readySource({ id: SOURCE_ID_2, name: 'other.md' })];
    const api = installFakeApi({
      ...handlers(),
      'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(sources)),
      'DELETE /api/v1/sources/:id': ({ params }) => {
        sources = sources.filter((s) => (s as { id: string }).id !== params.id);
        return json(204);
      },
    });
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete architecture.md' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('architecture.md')).toBeNull());
    expect(screen.getByText('other.md')).toBeTruthy();
    expect(api.callsTo('DELETE', `/api/v1/sources/${SOURCE_ID}`)).toHaveLength(1);
  });

  it('can delete a document that is waiting or has failed too', async () => {
    installFakeApi(handlers({ sources: [source({ name: 'waiting.md' }), failedSource({}, { id: SOURCE_ID_2, name: 'broken.pdf' })] }));
    renderApp(TAB);
    expect(await screen.findByRole('button', { name: 'Delete waiting.md' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete broken.pdf' })).toBeTruthy();
  });

  it('shows what the server said when it refuses, and keeps the document', async () => {
    installFakeApi({
      ...handlers({ sources: [readySource({ name: 'architecture.md' })] }),
      'DELETE /api/v1/sources/:id': () => json(500, { error: 'Something went wrong on the server.' }),
    });
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete architecture.md' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBeTruthy();
    expect(screen.getByText('architecture.md')).toBeTruthy();
  });

  it('reads the list again when the document was already gone, so it disappears', async () => {
    let gone = false;
    installFakeApi({
      ...handlers(),
      'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList(gone ? [] : [readySource({ name: 'architecture.md' })])),
      'DELETE /api/v1/sources/:id': () => {
        gone = true;
        return json(404, { error: 'Source not found.' });
      },
    });
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete architecture.md' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('architecture.md')).toBeNull());
  });

  it('puts the name in the question as text, never as markup', async () => {
    installFakeApi(handlers({ sources: [readySource({ name: '<img src=x onerror=alert(1)>.md' })] }));
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete <img src=x onerror=alert(1)>.md' }));
    expect(within(await screen.findByRole('dialog')).getByText(/<img src=x onerror=alert\(1\)>\.md\? Its text and chunks are removed\./)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('a document that failed (FR-013, FR-044)', () => {
  it('shows what went wrong and what to do, and offers no Retry for a failure that comes from the document', async () => {
    installFakeApi(handlers({ sources: [failedSource({}, { name: 'broken.pdf' })] }));
    renderApp(TAB);
    expect(await screen.findByText('This file could not be opened.')).toBeTruthy();
    expect(screen.getByText('Open it in the program that made it and save a fresh copy.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
  });

  it('offers Retry when the failure is one that trying again can help, and the document goes back to waiting', async () => {
    let retried = false;
    const failing = failedSource({ category: 'provider_unavailable', message: 'The provider is unavailable.', hint: 'Try again later.', retryable: true }, { name: 'design.md' });
    const api = installFakeApi({
      ...handlers(),
      'GET /api/v1/threat-models/:id/sources': () => json(200, sourceList([retried ? source({ name: 'design.md' }) : failing])),
      'POST /api/v1/sources/:id/retry': () => {
        retried = true;
        return json(200, source({ name: 'design.md' }));
      },
    });
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry design.md' }));
    await waitFor(() => expect(screen.getByText('Waiting')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Retry design.md' })).toBeNull();
    expect(api.callsTo('POST', `/api/v1/sources/${SOURCE_ID}/retry`)).toHaveLength(1);
  });

  it('says why when the retry is refused, and keeps the document as it was', async () => {
    const failing = failedSource({ category: 'cap_reached', message: 'The job reached its cap.', hint: 'Raise the cap.', retryable: true }, { name: 'design.md' });
    installFakeApi({
      ...handlers({ sources: [failing] }),
      'POST /api/v1/sources/:id/retry': () => json(409, { error: 'Retrying would reach the same cap. Ask the operator to raise JOB_TOKEN_CAP or JOB_COST_CAP.' }),
    });
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry design.md' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Retrying would reach the same cap.');
    expect(screen.getByText('The job reached its cap.')).toBeTruthy();
  });

  it('offers Retry for a ready document whose last refresh failed, with the refresh’s message and hint', async () => {
    const ready = readySource({ name: 'design.md', refresh_failure: { category: 'provider_unavailable', message: 'The embedding provider is unavailable.', hint: 'Try again later.', retryable: true } });
    installFakeApi(handlers({ sources: [ready] }));
    renderApp(TAB);
    expect(await screen.findByText('The embedding provider is unavailable.')).toBeTruthy();
    expect(screen.getByText('Try again later.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry design.md' })).toBeTruthy();
  });

  it('offers no Retry for a document that is ready, waiting or processing', async () => {
    installFakeApi(handlers({ sources: [readySource({ name: 'a.md' }), source({ id: SOURCE_ID_2, name: 'b.md' })] }));
    renderApp(TAB);
    await screen.findByText('a.md');
    expect(screen.queryByRole('button', { name: /^Retry/ })).toBeNull();
  });
});

describe('keeping embeddings in step with the model (FR-034)', () => {
  const outOfDate = (over: Record<string, unknown> = {}) => readySourceWith('out_of_date', { name: 'design.md', refreshable: true, ...over });

  it('says the embeddings are out of date, and offers Refresh embeddings only when they can be refreshed', async () => {
    installFakeApi(handlers({ sources: [outOfDate(), readySource({ id: SOURCE_ID_2, name: 'current.md' })] }));
    renderApp(TAB);
    expect(await screen.findByText(/Embeddings are out of date\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh embeddings of design.md' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh embeddings of current.md' })).toBeNull();
  });

  it('says no embedding provider is configured, and offers no refresh, for a source that is not refreshable', async () => {
    installFakeApi(handlers({ sources: [readySourceWith('no_provider', { name: 'design.md' })] }));
    renderApp(TAB);
    expect(await screen.findByText(/No embedding provider is configured\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Refresh embeddings/ })).toBeNull();
  });

  it('queues the refresh, then shows it in progress and goes on reading the list until it ends', async () => {
    let refreshing = false;
    const api = installFakeApi({
      ...handlers(),
      'GET /api/v1/threat-models/:id/sources': () =>
        json(200, sourceList([refreshing ? outOfDate({ refreshable: false, refresh: { state: 'running', progress: { step: 'embed', done: 64, total: 128 } } }) : outOfDate()])),
      'POST /api/v1/sources/:id/refresh': () => {
        refreshing = true;
        return json(200, outOfDate({ refreshable: false, refresh: { state: 'queued', progress: null } }));
      },
    });
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh embeddings of design.md' }));
    expect(await screen.findByText(/Refreshing embeddings/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Refresh embeddings of/ })).toBeNull();
    expect(api.callsTo('POST', `/api/v1/sources/${SOURCE_ID}/refresh`)).toHaveLength(1);
  });

  it('says why when the refresh is refused', async () => {
    installFakeApi({
      ...handlers({ sources: [outOfDate()] }),
      'POST /api/v1/sources/:id/refresh': () => json(409, { error: 'The embeddings of this source are current.' }),
    });
    renderApp(TAB);
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh embeddings of design.md' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The embeddings of this source are current.');
  });
});

describe('the limits on the add form (FR-004, FR-005, FR-009)', () => {
  it('says the largest file, how many of the threat model’s documents are used, and how full the document space is', async () => {
    installFakeApi(
      handlers({
        sources: [readySource({ name: 'a.md' }), readySource({ id: SOURCE_ID_2, name: 'b.md' })],
        limits: { max_bytes: 10 * 1024 * 1024, per_threat_model: 20, used_bytes: 5 * 1024 * 1024, document_space_bytes: 2 * 1024 ** 3 },
      }),
    );
    renderApp(TAB);
    const limits = await screen.findByRole('group', { name: 'Limits' });
    expect(within(limits).getByText('Files up to 10.0 MB')).toBeTruthy();
    expect(within(limits).getByText('2 of 20 documents in this threat model')).toBeTruthy();
    expect(within(limits).getByText('5.0 MB of 2.0 GB of document space used')).toBeTruthy();
  });

  it('says so when the threat model or the document space is full, so a refusal is no surprise', async () => {
    installFakeApi(
      handlers({
        sources: [readySource({ name: 'a.md' })],
        limits: { per_threat_model: 1, used_bytes: 2 * 1024 ** 3, document_space_bytes: 2 * 1024 ** 3 },
      }),
    );
    renderApp(TAB);
    const limits = await screen.findByRole('group', { name: 'Limits' });
    expect(within(limits).getByText('This threat model has reached its limit of documents')).toBeTruthy();
    expect(within(limits).getByText('The document space is full')).toBeTruthy();
  });

  it('is not shown when documents cannot be added at all', async () => {
    installFakeApi(handlers({ status: { ai: { generation: null, embedding: null } } }));
    renderApp(TAB);
    await screen.findByText(/Adding documents needs an embedding provider/);
    expect(screen.queryByRole('group', { name: 'Limits' })).toBeNull();
  });
});
