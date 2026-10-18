import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagramEditorContext } from '../diagram/DiagramEditorProvider.js';
import { MODEL, fakeEditor } from '../diagram/test-helpers.js';
import { installFakeApi, json } from '../test-utils.js';
import { ExportModel } from './ExportModel.js';

// contracts/web-ui.md: the export buttons on the threat model page.

const EXPORT = 'GET /api/v1/threat-models/:id/export';
const FILE = '{\n  "format": "scrylux"\n}\n';

function file(body: string, name = 'payments-2026-10-10.scrylux.json'): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } });
}

let clicked: { download: string; href: string }[];
let made = 0;

beforeEach(() => {
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    clicked.push({ download: this.download, href: this.href });
  });
  URL.createObjectURL = vi.fn(() => `blob:fake-${++made}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(handlers: Parameters<typeof installFakeApi>[0], editor = fakeEditor()) {
  const api = installFakeApi(handlers);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DiagramEditorContext.Provider value={editor}>
        <ExportModel threatModelId={MODEL} />
      </DiagramEditorContext.Provider>
    </QueryClientProvider>,
  );
  return { api, editor };
}

const scryluxButton = () => screen.getByRole('button', { name: 'Download Scrylux file' });
const status = () => screen.getByRole('status');
const requestedUrls = (api: ReturnType<typeof installFakeApi>): string[] =>
  api.fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : '')).filter((url) => url.includes('/export'));

describe('ExportModel', () => {
  it('has a group named Export holding the Scrylux file and OTM file buttons, and an empty status', () => {
    setup({});
    const group = screen.getByRole('group', { name: 'Export' });
    expect(within(group).getByRole('button', { name: 'Download Scrylux file' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: 'Download OTM file' })).toBeTruthy();
    expect(status().textContent).toBe('');
  });

  it('asks the API for the Scrylux file of this threat model, with the bearer token only', async () => {
    const { api } = setup({ [EXPORT]: () => file(FILE) });
    await userEvent.click(scryluxButton());
    await waitFor(() => expect(status().textContent).toBe('Export downloaded.'));
    expect(requestedUrls(api)).toEqual([`/api/v1/threat-models/${MODEL}/export?format=scrylux`]);
    const asked = api.fetchMock.mock.calls.find(([input]) => typeof input === 'string' && input.includes('/export'));
    expect(new Headers(asked?.[1]?.headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('asks the API for the OTM file with the other button', async () => {
    const { api } = setup({ [EXPORT]: () => file(FILE, 'my-model-2026-10-10.otm.json') });
    await userEvent.click(screen.getByRole('button', { name: 'Download OTM file' }));
    await waitFor(() => expect(status().textContent).toBe('Export downloaded.'));
    expect(requestedUrls(api)).toEqual([`/api/v1/threat-models/${MODEL}/export?format=otm`]);
    expect(clicked[0]?.download).toBe('my-model-2026-10-10.otm.json');
  });

  it('is disabled and says the export is being prepared while the request is open', async () => {
    let release: (response: Response) => void = () => undefined;
    setup({ [EXPORT]: () => new Promise<Response>((resolve) => (release = resolve)) });
    await userEvent.click(scryluxButton());
    expect((scryluxButton() as HTMLButtonElement).disabled).toBe(true);
    expect(status().textContent).toBe('Preparing export…');
    release(file(FILE));
    await waitFor(() => expect((scryluxButton() as HTMLButtonElement).disabled).toBe(false));
  });

  it('saves the body under the name the server gave, and falls back to a name of its own', async () => {
    setup({ [EXPORT]: () => file(FILE, 'my-model-2026-10-10.scrylux.json') });
    await userEvent.click(scryluxButton());
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]?.download).toBe('my-model-2026-10-10.scrylux.json');
  });

  it('falls back to a name of its own if the server gave none', async () => {
    setup({ [EXPORT]: () => new Response(FILE, { status: 200 }) });
    await userEvent.click(scryluxButton());
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]?.download).toMatch(/^threat-model-\d{4}-\d{2}-\d{2}\.scrylux\.json$/);
  });

  describe('with diagram changes that are not saved', () => {
    const unsaved = () => fakeEditor({ pendingCount: 2, status: 'saving' });

    it('asks first, with the contract’s message, and downloads nothing on Cancel', async () => {
      const { api } = setup({ [EXPORT]: () => file(FILE) }, unsaved());
      await userEvent.click(scryluxButton());
      const dialog = document.querySelector('dialog') as HTMLElement;
      expect(dialog.textContent).toContain('Download export?');
      expect(dialog.textContent).toContain("Some diagram changes aren't saved yet. The export holds only what is saved.");
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(requestedUrls(api)).toEqual([]);
    });

    it('downloads on "Download anyway"', async () => {
      setup({ [EXPORT]: () => file(FILE) }, unsaved());
      await userEvent.click(scryluxButton());
      const dialog = document.querySelector('dialog') as HTMLElement;
      await userEvent.click(within(dialog).getByRole('button', { name: 'Download anyway' }));
      await waitFor(() => expect(status().textContent).toBe('Export downloaded.'));
    });
  });

  describe('when the export fails', () => {
    it('says the threat model is gone for a 404', async () => {
      setup({ [EXPORT]: () => json(404, { error: 'Threat model not found' }) });
      await userEvent.click(scryluxButton());
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('This threat model no longer exists.'));
      expect(clicked).toEqual([]);
      expect((scryluxButton() as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows the server’s message for another API error', async () => {
      setup({ [EXPORT]: () => json(400, { error: 'format must be scrylux' }) });
      await userEvent.click(scryluxButton());
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('format must be scrylux'));
    });

    it('says to try again for a failure that is not an API error', async () => {
      setup({ [EXPORT]: () => Promise.reject(new TypeError('network')) });
      await userEvent.click(scryluxButton());
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The export could not be downloaded. Try again.'));
    });
  });
});
