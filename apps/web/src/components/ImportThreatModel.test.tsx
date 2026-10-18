import { IMPORT_MAX_BYTES } from '@scrylux/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ID, installFakeApi, json, threatModel } from '../test-utils.js';
import { ImportThreatModel } from './ImportThreatModel.js';

// contracts/web-ui.md, "ImportThreatModel", and data-model.md, "Web state": choose a file, check it, preview with
// editable names, confirm.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CHECK = 'POST /api/v1/projects/:id/imports/check';
const IMPORT = 'POST /api/v1/projects/:id/imports';
const LIST = 'GET /api/v1/projects/:id/threat-models';
const NEW_ID = '55555555-5555-4555-8555-555555555555';

const scryluxFile = (name = 'Checkout') => ({
  format: 'scrylux',
  format_version: 1,
  exported_at: '2026-10-10T09:30:00.000Z',
  project: { name: 'Payments' },
  threat_model: { name, methodology: 'STRIDE', status: 'in_review' },
  elements: [],
  threats: [],
  mitigations: [],
});

const summary = (overrides: Record<string, unknown> = {}, notes: unknown[] = []) => ({
  models: [{ name: 'Checkout', name_issue: null, status: 'in_review', elements: 8, threats: 10, mitigations: 4, ...overrides }],
  notes,
});

const created = (name = 'Checkout') => ({ ...threatModel({ id: NEW_ID, name }) });

// The page the import navigates to, showing what it was handed in the navigation state.
function ImportedPage() {
  const state = useLocation().state as { importSummary?: { notes: unknown[] } } | null;
  return (
    <>
      <p>Imported model page</p>
      <p>{state?.importSummary === undefined ? 'No summary was passed' : `Summary passed with ${state.importSummary.notes.length} notes`}</p>
    </>
  );
}

function setup(handlers: Parameters<typeof installFakeApi>[0]) {
  const api = installFakeApi({ [LIST]: () => json(200, [threatModel({ name: 'Existing model' })]), ...handlers });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}`]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ImportThreatModel projectId={PROJECT_ID} />} />
          <Route path="/threat-models/:threatModelId" element={<ImportedPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return api;
}

const upload = async (body: unknown, name = 'model.json') => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  await userEvent.upload(screen.getByLabelText('File to import'), new File([text], name, { type: 'application/json' }));
};
const open = () => userEvent.click(screen.getByRole('button', { name: 'Import threat model' }));
const importButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Import' });
const checks = (api: ReturnType<typeof installFakeApi>) => api.callsTo('POST', /imports\/check$/);

describe('ImportThreatModel', () => {
  it('opens a panel with a file input labelled "File to import"', async () => {
    setup({});
    expect(screen.queryByLabelText('File to import')).toBeNull();
    await open();
    expect(screen.getByLabelText('File to import')).toBeTruthy();
  });

  it('refuses a file over the limit on the spot: it is never read, and nothing is sent', async () => {
    const api = setup({});
    await open();
    const big = new File(['{}'], 'big.json', { type: 'application/json' });
    Object.defineProperty(big, 'size', { value: IMPORT_MAX_BYTES + 1 });
    const read = vi.spyOn(big, 'text');
    await userEvent.upload(screen.getByLabelText('File to import'), big);
    expect(await screen.findByText('This file is larger than 64 MiB, the most Scrylux can import.')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
    expect(checks(api)).toHaveLength(0);
  });

  const READS = 'Scrylux imports Scrylux files (version 1), OTM 0.2.0 files in JSON, and Threat Dragon version 2 files.';
  it.each([
    ['not JSON', 'this is not json', `This file isn't JSON. ${READS}`],
    ['JSON of no format Scrylux reads', { hello: 1 }, `This file isn't in a format Scrylux reads. ${READS}`],
    ['a JSON array', [], `This file isn't in a format Scrylux reads. ${READS}`],
  ])('says which files Scrylux imports for %s, and sends nothing', async (_label, body, message) => {
    const api = setup({});
    await open();
    await upload(body);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(checks(api)).toHaveLength(0);
  });

  it('says how to convert a Threat Dragon version 1 file, and sends nothing', async () => {
    const api = setup({});
    await open();
    await upload({ version: '1.0', detail: { diagrams: [{ diagramJson: {} }] } });
    expect(await screen.findByText('This is a Threat Dragon version 1 file. Open and save it in Threat Dragon 2, which converts it, then import it here.')).toBeTruthy();
    expect(checks(api)).toHaveLength(0);
  });

  describe('a Scrylux file', () => {
    it('is checked, and the preview names the format, the model, its status and its counts', async () => {
      const api = setup({ [CHECK]: () => json(200, summary()) });
      await open();
      await upload(scryluxFile());
      const heading = await screen.findByRole('heading', { name: 'Ready to import' });
      expect(document.activeElement).toBe(heading);
      expect(screen.getByText(/Scrylux file/)).toBeTruthy();
      expect(screen.getByLabelText<HTMLInputElement>('Name of threat model 1').value).toBe('Checkout');
      expect(screen.getByText(/in review/)).toBeTruthy();
      expect(screen.getByText(/8 elements, 10 threats, 4 mitigations/)).toBeTruthy();
      expect(screen.getByText('Everything in this file will be imported.')).toBeTruthy();
      expect(checks(api)).toHaveLength(1);
      expect(checks(api)[0]?.body).toEqual({ format: 'scrylux', file: scryluxFile() });
    });

    it('says what it is doing while the check runs', async () => {
      let release: (response: Response) => void = () => undefined;
      setup({ [CHECK]: () => new Promise<Response>((resolve) => (release = resolve)) });
      await open();
      await upload(scryluxFile());
      expect((await screen.findByRole('status')).textContent).toBe('Checking Scrylux file…');
      expect(screen.getByLabelText<HTMLInputElement>('File to import').disabled).toBe(true);
      release(json(200, summary()));
      await screen.findByRole('heading', { name: 'Ready to import' });
    });

    it('shows a refusal from the check, with the message, and offers another file', async () => {
      setup({ [CHECK]: () => json(400, { error: 'file.threats.3.origin: AI-drafted threats cannot be imported yet' }) });
      await open();
      await upload(scryluxFile());
      expect(await screen.findByText("This file can't be imported")).toBeTruthy();
      expect(screen.getByText('file.threats.3.origin: AI-drafted threats cannot be imported yet')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: 'Choose another file' }));
      expect(screen.getByLabelText('File to import')).toBeTruthy();
    });
  });

  describe('an OTM file', () => {
    const otmFile = () => ({ otmVersion: '0.2.0', project: { name: 'Shop', id: 'shop' }, trustZones: [], components: [], dataflows: [], threats: [], mitigations: [] });

    it('is recognised, named in the status line and the preview, and sent as an OTM file', async () => {
      let release: (response: Response) => void = () => undefined;
      const api = setup({ [CHECK]: () => new Promise<Response>((resolve) => (release = resolve)) });
      await open();
      await upload(otmFile());
      expect((await screen.findByRole('status')).textContent).toBe('Checking OTM file…');
      release(json(200, summary({ name: 'Shop', status: 'draft' })));
      await screen.findByRole('heading', { name: 'Ready to import' });
      expect(screen.getByText('OTM file')).toBeTruthy();
      expect(checks(api)[0]?.body).toEqual({ format: 'otm', file: otmFile() });
    });

    it('says how many parts of the file will not be carried over', async () => {
      setup({ [CHECK]: () => json(200, summary({}, [{ path: 'file.assets.0', kind: 'not_imported.asset', label: 'Card data' }, { path: 'file.assets.1', kind: 'not_imported.asset' }])) });
      await open();
      await upload(otmFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      expect(screen.getByText("2 parts of this file won't be carried over or were changed to fit.")).toBeTruthy();
      expect(screen.queryByText('Everything in this file will be imported.')).toBeNull();
    });
  });

  describe('a Threat Dragon file with several diagrams', () => {
    const tdFile = () => ({
      version: '2.3.0',
      summary: { title: 'Shop' },
      detail: { diagrams: [{ title: 'Web', diagramType: 'STRIDE', cells: [] }, { title: 'Batch', diagramType: 'STRIDE', cells: [] }] },
    });
    const twoModels = (first: Record<string, unknown> = {}, second: Record<string, unknown> = {}) => ({
      models: [
        { name: 'Shop – Web', name_issue: null, status: 'draft', elements: 5, threats: 2, mitigations: 1, ...first },
        { name: 'Shop – Batch', name_issue: null, status: 'draft', elements: 3, threats: 0, mitigations: 0, ...second },
      ],
      notes: [],
    });

    it('is recognised, and shows one name field per model with its own counts', async () => {
      setup({ [CHECK]: () => json(200, twoModels()) });
      await open();
      await upload(tdFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      expect(screen.getByText('Threat Dragon file')).toBeTruthy();
      expect(screen.getByLabelText<HTMLInputElement>('Name of threat model 1').value).toBe('Shop – Web');
      expect(screen.getByLabelText<HTMLInputElement>('Name of threat model 2').value).toBe('Shop – Batch');
      expect(screen.getByText(/5 elements, 2 threats, 1 mitigations/)).toBeTruthy();
      expect(screen.getByText(/3 elements, 0 threats, 0 mitigations/)).toBeTruthy();
    });

    it('sends the format and both names, with the renamed one changed', async () => {
      const api = setup({
        [CHECK]: () => json(200, twoModels()),
        [IMPORT]: () => json(201, { threat_models: [created('Shop – Web'), created('Renamed')], summary: twoModels() }),
      });
      await open();
      await upload(tdFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      const second = screen.getByLabelText('Name of threat model 2');
      await userEvent.clear(second);
      await userEvent.type(second, 'Renamed');
      await userEvent.click(importButton());
      await waitFor(() => expect(api.callsTo('POST', `/api/v1/projects/${PROJECT_ID}/imports`)).toHaveLength(1));
      expect(api.callsTo('POST', `/api/v1/projects/${PROJECT_ID}/imports`)[0]?.body).toEqual({ format: 'threat-dragon', names: ['Shop – Web', 'Renamed'], file: tdFile() });
    });

    it('says two models have the same name, on both, and enables Import once they differ', async () => {
      setup({ [CHECK]: () => json(200, twoModels({ name: 'Same' }, { name: 'Same' })) });
      await open();
      await upload(tdFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      expect(screen.getAllByText('Another threat model in this file has the same name.')).toHaveLength(2);
      expect(importButton().disabled).toBe(true);
      const second = screen.getByLabelText('Name of threat model 2');
      await userEvent.type(second, ' two');
      expect(screen.queryByText('Another threat model in this file has the same name.')).toBeNull();
      expect(importButton().disabled).toBe(false);
    });

    it('stays on the project page after importing several, says how many, and refreshes the list', async () => {
      const api = setup({
        [CHECK]: () => json(200, twoModels()),
        [IMPORT]: () => json(201, { threat_models: [created('Shop – Web'), created('Shop – Batch')], summary: twoModels() }),
      });
      await open();
      await upload(tdFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      const before = api.callsTo('GET', `/api/v1/projects/${PROJECT_ID}/threat-models`).length;
      await userEvent.click(importButton());
      const status = await screen.findByText('Imported 2 threat models.');
      expect(document.activeElement).toBe(status);
      expect(screen.queryByText('Imported model page')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Ready to import' })).toBeNull();
      await waitFor(() => expect(api.callsTo('GET', `/api/v1/projects/${PROJECT_ID}/threat-models`).length).toBeGreaterThan(before));
    });

    it('shows a 409 on the name that was taken, and keeps both names', async () => {
      setup({
        [CHECK]: () => json(200, twoModels()),
        [IMPORT]: () => json(409, { error: 'names.1: a threat model with this name already exists in this project' }),
      });
      await open();
      await upload(tdFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      await userEvent.click(importButton());
      await waitFor(() => expect(screen.getByLabelText('Name of threat model 2').getAttribute('aria-invalid')).toBe('true'));
      expect(screen.getByLabelText('Name of threat model 1').getAttribute('aria-invalid')).toBeNull();
      expect(screen.getByLabelText<HTMLInputElement>('Name of threat model 1').value).toBe('Shop – Web');
    });
  });

  describe('a name issue', () => {
    it('shows "taken" on the field and disables Import', async () => {
      setup({ [CHECK]: () => json(200, summary({ name: 'Existing model', name_issue: 'taken' })) });
      await open();
      await upload(scryluxFile('Existing model'));
      expect(await screen.findByText('A threat model with this name already exists in this project.')).toBeTruthy();
      expect(importButton().disabled).toBe(true);
      expect(screen.getByLabelText('Name of threat model 1').getAttribute('aria-invalid')).toBe('true');
    });

    it('is worked out in the browser while the name is edited: no request is sent, and Import is enabled once it is usable', async () => {
      const api = setup({ [CHECK]: () => json(200, summary({ name: 'Existing model', name_issue: 'taken' })) });
      await open();
      await upload(scryluxFile('Existing model'));
      await screen.findByText('A threat model with this name already exists in this project.');
      const field = screen.getByLabelText('Name of threat model 1');
      await userEvent.clear(field);
      await userEvent.type(field, 'A fresh name');
      expect(screen.queryByText('A threat model with this name already exists in this project.')).toBeNull();
      expect(importButton().disabled).toBe(false);
      await userEvent.clear(field);
      await userEvent.type(field, '  existing MODEL ');
      expect(screen.getByText('A threat model with this name already exists in this project.')).toBeTruthy();
      expect(importButton().disabled).toBe(true);
      await userEvent.clear(field);
      expect(screen.getByText('Enter a name.')).toBeTruthy();
      expect(checks(api)).toHaveLength(1);
    });
  });

  describe('importing', () => {
    it('sends the format, the names and the file, and opens the new threat model when there is one', async () => {
      const api = setup({
        [CHECK]: () => json(200, summary()),
        [IMPORT]: () => json(201, { threat_models: [created()], summary: summary() }),
      });
      await open();
      await upload(scryluxFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      await userEvent.click(importButton());
      expect(await screen.findByText('Imported model page')).toBeTruthy();
      const sent = api.callsTo('POST', `/api/v1/projects/${PROJECT_ID}/imports`);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.body).toEqual({ format: 'scrylux', names: ['Checkout'], file: scryluxFile() });
    });

    it('says it is importing, and disables both buttons meanwhile', async () => {
      let release: (response: Response) => void = () => undefined;
      setup({ [CHECK]: () => json(200, summary()), [IMPORT]: () => new Promise<Response>((resolve) => (release = resolve)) });
      await open();
      await upload(scryluxFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      await userEvent.click(importButton());
      expect(screen.getByRole('status').textContent).toBe('Importing…');
      expect(importButton().disabled).toBe(true);
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(true);
      release(json(201, { threat_models: [created()], summary: summary() }));
      await screen.findByText('Imported model page');
    });

    it('returns to the preview on a 409, with the message on the name field and the names kept', async () => {
      setup({
        [CHECK]: () => json(200, summary()),
        [IMPORT]: () => json(409, { error: 'names.0: a threat model with this name already exists in this project' }),
      });
      await open();
      await upload(scryluxFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      const field = screen.getByLabelText('Name of threat model 1');
      await userEvent.clear(field);
      await userEvent.type(field, 'Mine');
      await userEvent.click(importButton());
      await waitFor(() => expect(screen.getByText('A threat model with this name already exists in this project.')).toBeTruthy());
      expect(screen.getByLabelText<HTMLInputElement>('Name of threat model 1').value).toBe('Mine');
      expect(screen.queryByText('Imported model page')).toBeNull();
    });

    it('shows another failure as a message, and stays on the preview', async () => {
      setup({ [CHECK]: () => json(200, summary()), [IMPORT]: () => json(404, { error: 'Project not found' }) });
      await open();
      await upload(scryluxFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      await userEvent.click(importButton());
      expect((await screen.findByRole('alert')).textContent).toContain('This project no longer exists.');
    });
  });

  describe('after an import that left something out (FR-013a, FR-016, US1/AC2, US4/AC2)', () => {
    const OTHER_ID = '66666666-6666-4666-8666-666666666666';
    // The check and the import give the same summary for the same file; these differ on purpose, to show that what the
    // model page is handed is what the import answered.
    const previewNotes = [{ path: 'file.assets.0', kind: 'not_imported.asset', label: 'Only in the preview' }];
    const resultNotes = [
      { path: 'file.detail.diagrams.0.cells.3', kind: 'not_imported.boundary_line', label: 'Perimeter' },
      { path: 'file.components.1', kind: 'mapped.component_type', label: 'Web Service', detail: 'process' },
    ];
    const one = (notes: unknown[]) => ({ ...summary({ name: 'Shop', status: 'draft', elements: 5, threats: 2, mitigations: 1 }, notes) });
    const answered = (notes: unknown[]) => json(201, { threat_models: [created('Shop')], summary: one(notes) });
    const importedOne = async (notes: unknown[]) => {
      setup({ [CHECK]: () => json(200, one(previewNotes)), [IMPORT]: () => answered(notes) });
      await open();
      await upload(scryluxFile('Shop'));
      await screen.findByRole('heading', { name: 'Ready to import' });
      await userEvent.click(importButton());
    };

    describe('one threat model', () => {
      it('takes the user to it, handing over the import’s own summary, not the preview’s', async () => {
        await importedOne(resultNotes);
        expect(await screen.findByText('Imported model page')).toBeTruthy();
        expect(screen.getByText('Summary passed with 2 notes')).toBeTruthy();
        expect(screen.queryByRole('heading', { name: 'Imported' })).toBeNull();
      });

      it('hands over nothing when nothing was left out', async () => {
        await importedOne([]);
        expect(await screen.findByText('Imported model page')).toBeTruthy();
        expect(screen.getByText('No summary was passed')).toBeTruthy();
      });
    });

    describe('several threat models', () => {
      const several = {
        threat_models: [created('Shop – Web'), { ...created('Shop – Batch'), id: OTHER_ID }],
        summary: { models: [one([]).models[0], { ...one([]).models[0], name: 'Shop – Batch' }], notes: resultNotes },
      };
      const importedSeveral = async () => {
        setup({ [CHECK]: () => json(200, one(previewNotes)), [IMPORT]: () => json(201, several) });
        await open();
        await upload(scryluxFile('Shop'));
        await screen.findByRole('heading', { name: 'Ready to import' });
        await userEvent.click(importButton());
        return screen.findByRole('heading', { name: 'Imported' });
      };

      it('stays on the project page and shows what the import answered, not the preview’s', async () => {
        const heading = await importedSeveral();
        expect(document.activeElement).toBe(heading);
        expect(screen.queryByText('Imported model page')).toBeNull();
        expect(screen.getByText('Trust boundary lines (not imported)')).toBeTruthy();
        expect(screen.getByText('Components with a type Scrylux does not have (imported as process)')).toBeTruthy();
        expect(screen.queryByText('Only in the preview')).toBeNull();
        expect(screen.getByText("2 parts of this file weren't carried over or were changed to fit.")).toBeTruthy();
      });

      it('says what was created, with its counts, and links to every threat model', async () => {
        await importedSeveral();
        expect(screen.getByText(/Shop – Web: 5 elements, 2 threats, 1 mitigations/)).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Open Shop – Web' }).getAttribute('href')).toBe(`/threat-models/${NEW_ID}`);
        expect(screen.getByRole('link', { name: 'Open Shop – Batch' }).getAttribute('href')).toBe(`/threat-models/${OTHER_ID}`);
        await userEvent.click(screen.getByRole('link', { name: 'Open Shop – Batch' }));
        expect(await screen.findByText('Imported model page')).toBeTruthy();
      });

      it('closes on Done, with the count in the status line, which takes the focus', async () => {
        await importedSeveral();
        await userEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.queryByRole('heading', { name: 'Imported' })).toBeNull();
        const status = screen.getByRole('status');
        expect(status.textContent).toBe('Imported 2 threat models.');
        expect(document.activeElement).toBe(status);
      });
    });
  });

  describe('what will not be carried over (FR-016)', () => {
    const notes = [
      { path: 'file.detail.diagrams.0.cells.3', kind: 'not_imported.boundary_line', label: 'Perimeter' },
      { path: 'file.detail.diagrams.0.cells.7', kind: 'not_imported.boundary_line' },
      { path: 'file.components.0', kind: 'mapped.component_type', label: 'Web Service', detail: 'process' },
      { path: 'file.detail.diagrams.0.cells.5', kind: 'not_imported.field', label: 'API', detail: 'privilegeLevel' },
      { path: 'file.threats.0', kind: 'mapped.severity', label: 'Odd threat', detail: 'TBA' },
      { path: 'file.trustZones.0', kind: 'adjusted.layout', label: 'Tiny', detail: 'enlarged' },
      { path: 'file.components.2.threats.0', kind: 'mapped.status', label: 'Moved', detail: 'Transferred' },
    ];
    const open1 = async () => {
      setup({ [CHECK]: () => json(200, summary({}, notes)) });
      await open();
      await upload(scryluxFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
    };

    it('says how many parts, and never says everything will be imported', async () => {
      await open1();
      expect(screen.getByText("7 parts of this file won't be carried over or were changed to fit.")).toBeTruthy();
      expect(screen.queryByText('Everything in this file will be imported.')).toBeNull();
    });

    it('groups the notes by kind under fixed headings, in the order of the kinds, as a list of lists', async () => {
      await open1();
      const headings = screen.getAllByRole('heading', { level: 5 }).map((heading) => heading.textContent);
      expect(headings).toEqual([
        'Trust boundary lines (not imported)',
        'Fields with no place in a threat model (not imported)',
        'Components with a type Scrylux does not have (imported as process)',
        'Statuses Scrylux does not have (imported with the default)',
        'Severities or likelihoods that were missing or unknown (imported as Medium)',
        'Positions Scrylux could not hold',
      ]);
      const lines = screen.getAllByRole('list').filter((list) => list.closest('[aria-label="Not carried over"]') !== null);
      expect(lines.length).toBeGreaterThan(1);
    });

    it('shows each item with its name (or "Unnamed"), what was done, and its place in the file in code', async () => {
      await open1();
      const group = screen.getByRole('heading', { name: 'Trust boundary lines (not imported)' }).parentElement as HTMLElement;
      const items = within(group).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual(['Perimeter file.detail.diagrams.0.cells.3', 'Unnamed file.detail.diagrams.0.cells.7']);
      expect(within(items[0] as HTMLElement).getByText('file.detail.diagrams.0.cells.3').tagName).toBe('CODE');
      const fields = screen.getByRole('heading', { name: 'Fields with no place in a threat model (not imported)' }).parentElement as HTMLElement;
      expect(within(fields).getByText(/API/).textContent).toContain('privilege level');
      const layout = screen.getByRole('heading', { name: 'Positions Scrylux could not hold' }).parentElement as HTMLElement;
      expect(layout.textContent).toContain('enlarged to 40 × 40');
      const severity = screen.getByRole('heading', { name: /Severities or likelihoods/ }).parentElement as HTMLElement;
      expect(severity.textContent).toContain('TBA');
      const status = screen.getByRole('heading', { name: /Statuses Scrylux does not have/ }).parentElement as HTMLElement;
      expect(status.textContent).toContain('Transferred');
    });

    it('shows hostile names as text', async () => {
      setup({ [CHECK]: () => json(200, summary({}, [{ path: 'file.assets.0', kind: 'not_imported.asset', label: '<img src=x onerror=alert(1)>' }])) });
      await open();
      await upload(scryluxFile());
      await screen.findByRole('heading', { name: 'Ready to import' });
      expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
      expect(document.querySelector('img')).toBeNull();
    });
  });

  it('closes on Cancel and sends nothing more', async () => {
    const api = setup({ [CHECK]: () => json(200, summary()) });
    await open();
    await upload(scryluxFile());
    await screen.findByRole('heading', { name: 'Ready to import' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('File to import')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ready to import' })).toBeNull();
    expect(api.callsTo('POST', /imports$/)).toHaveLength(0);
  });

  it('shows hostile text as text', async () => {
    setup({ [CHECK]: () => json(200, summary({ name: '<img src=x onerror=alert(1)>' })) });
    await open();
    await upload(scryluxFile('<img src=x onerror=alert(1)>'));
    const field = await screen.findByLabelText<HTMLInputElement>('Name of threat model 1');
    expect(field.value).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });
});
