import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ELEMENT_ID, MODEL_ID, citation, element, installFakeApi, json, project, renderApp, threatModel } from '../test-utils.js';

// The Assets tab of a threat model (Phase 3 Milestone 5, US5; FR-019, FR-021, contracts/ui.md "The Assets tab"): assets with their holders and assumptions,
// each with add, edit and delete; every text is shown as text; the API's refusals are shown beside the form.

afterEach(() => {
  vi.unstubAllGlobals();
});

const TAB = `/threat-models/${MODEL_ID}/assets`;
const NOW = '2026-11-10T09:00:00.000Z';
const ASSET_ID = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
const ASSUMPTION_ID = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1';
const STORE_ID = '77777777-7777-4777-8777-777777777778';

const asset = (over: Record<string, unknown> = {}) => ({ id: ASSET_ID, threat_model_id: MODEL_ID, name: 'Session tokens', description: 'Bearer tokens.', holder_ids: [ELEMENT_ID], created_at: NOW, updated_at: NOW, ...over });
const assumption = (over: Record<string, unknown> = {}) => ({ id: ASSUMPTION_ID, threat_model_id: MODEL_ID, statement: 'The database is not exposed.', created_at: NOW, updated_at: NOW, ...over });

interface Setup {
  assets?: unknown[];
  assumptions?: unknown[];
  provenance?: unknown[];
  extra?: Record<string, (ctx: { body: unknown }) => Response>;
}

function open({ assets = [asset()], assumptions = [assumption()], provenance = [], extra = {} }: Setup = {}) {
  const state = { assets, assumptions };
  const api = installFakeApi({
    'GET /api/v1/threat-models/:id': () => json(200, threatModel()),
    'GET /api/v1/projects/:id': () => json(200, project()),
    'GET /api/v1/threat-models/:id/elements': () => json(200, [element({ name: 'API gateway' }), element({ id: STORE_ID, type: 'data_store', name: 'Orders DB' })]),
    'GET /api/v1/threat-models/:id/threats': () => json(200, []),
    'GET /api/v1/threat-models/:id/mitigations': () => json(200, []),
    'GET /api/v1/threat-models/:id/assets': () => json(200, state.assets),
    'GET /api/v1/threat-models/:id/assumptions': () => json(200, state.assumptions),
    'GET /api/v1/threat-models/:id/provenance': () => json(200, provenance),
    ...extra,
  });
  renderApp(TAB);
  return { api, state };
}

const assetsSection = () => screen.findByRole('region', { name: 'Assets' });
const assumptionsSection = () => screen.findByRole('region', { name: 'Assumptions' });

describe('the tab', () => {
  it('is reached from the threat model’s tabs, right after Diagram', async () => {
    open();
    const nav = await screen.findByRole('navigation', { name: 'Threat model views' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Diagram', 'Assets and assumptions', 'Threats', 'Sources', 'Draft']);
    expect(within(nav).getByRole('link', { name: 'Assets and assumptions' }).getAttribute('href')).toBe(TAB);
  });

  it('lists the assets with their descriptions and holders, and the assumptions', async () => {
    open();
    const assets = await assetsSection();
    expect(within(assets).getByRole('heading', { name: 'Session tokens' })).toBeTruthy();
    expect(within(assets).getByText('Bearer tokens.')).toBeTruthy();
    const holder = within(assets).getByRole('link', { name: 'API gateway' });
    expect(holder.getAttribute('href')).toBe(`/threat-models/${MODEL_ID}/diagram?element=${ELEMENT_ID}`);
    expect(within(await assumptionsSection()).getByText('The database is not exposed.')).toBeTruthy();
  });

  it('opens the diagram with the holder selected when its name is followed', async () => {
    const user = userEvent.setup();
    open();
    await user.click(within(await assetsSection()).getByRole('link', { name: 'API gateway' }));
    const panel = await screen.findByRole('complementary', { name: 'Properties' });
    await waitFor(() => expect(within(panel).getByLabelText<HTMLInputElement>('Name').value).toBe('API gateway'));
  });

  it('says what each section is when it is empty', async () => {
    open({ assets: [], assumptions: [] });
    expect((await assetsSection()).textContent).toContain('No assets yet');
    expect((await assumptionsSection()).textContent).toContain('No assumptions yet');
  });

  it('shows every text as text, never as markup', async () => {
    open({ assets: [asset({ name: '<img src=x onerror=alert(1)>', description: '<b>bold</b>' })], assumptions: [assumption({ statement: '<script>alert(1)</script>' })] });
    const assets = await assetsSection();
    expect(within(assets).getByText('<b>bold</b>')).toBeTruthy();
    expect(within(await assumptionsSection()).getByText('<script>alert(1)</script>')).toBeTruthy();
    expect(document.querySelector('img, script, b')).toBeNull();
  });
});

describe('assets', () => {
  it('adds an asset with a name, a description and the elements that hold it', async () => {
    const user = userEvent.setup();
    const created = asset({ id: 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', name: 'Orders', description: 'Order records.', holder_ids: [STORE_ID] });
    const { api, state } = open({
      extra: {
        'POST /api/v1/threat-models/:id/assets': () => {
          state.assets = [...state.assets, created];
          return json(201, created);
        },
      },
    });
    const assets = await assetsSection();
    await user.click(within(assets).getByRole('button', { name: 'Add asset' }));
    const form = within(assets).getByRole('form', { name: 'Add asset' });
    await user.type(within(form).getByLabelText('Name'), 'Orders');
    await user.type(within(form).getByLabelText('Description'), 'Order records.');
    await user.click(within(form).getByLabelText('Orders DB'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/assets`)).toHaveLength(1));
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/assets`)[0]?.body).toEqual({ name: 'Orders', description: 'Order records.', holder_ids: [STORE_ID] });
    expect(await within(assets).findByRole('heading', { name: 'Orders' })).toBeTruthy();
  });

  it('shows the API’s refusal of a repeated name beside the form, and keeps the form', async () => {
    const user = userEvent.setup();
    open({ extra: { 'POST /api/v1/threat-models/:id/assets': () => json(409, { error: 'An asset with this name already exists' }) } });
    const assets = await assetsSection();
    await user.click(within(assets).getByRole('button', { name: 'Add asset' }));
    const form = within(assets).getByRole('form', { name: 'Add asset' });
    await user.type(within(form).getByLabelText('Name'), 'Session tokens');
    await user.type(within(form).getByLabelText('Description'), 'd');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('An asset with this name already exists');
  });

  it('edits an asset, sending only what changed, with its holders replaced when they changed', async () => {
    const user = userEvent.setup();
    const { api } = open({ extra: { 'PATCH /api/v1/assets/:id': () => json(200, asset({ description: 'Edited.', holder_ids: [STORE_ID] })) } });
    const assets = await assetsSection();
    await user.click(within(assets).getByRole('button', { name: 'Edit Session tokens' }));
    const form = within(assets).getByRole('form', { name: 'Edit asset' });
    expect(within(form).getByLabelText<HTMLInputElement>('Name').value).toBe('Session tokens');
    expect(within(form).getByLabelText<HTMLInputElement>('API gateway').checked).toBe(true);
    await user.clear(within(form).getByLabelText('Description'));
    await user.type(within(form).getByLabelText('Description'), 'Edited.');
    await user.click(within(form).getByLabelText('API gateway'));
    await user.click(within(form).getByLabelText('Orders DB'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.callsTo('PATCH', `/api/v1/assets/${ASSET_ID}`)).toHaveLength(1));
    expect(api.callsTo('PATCH', `/api/v1/assets/${ASSET_ID}`)[0]?.body).toEqual({ description: 'Edited.', holder_ids: [STORE_ID] });
  });

  it('deletes an asset after a confirmation', async () => {
    const user = userEvent.setup();
    const { api, state } = open({
      extra: {
        'DELETE /api/v1/assets/:id': () => {
          state.assets = [];
          return json(204);
        },
      },
    });
    const assets = await assetsSection();
    await user.click(within(assets).getByRole('button', { name: 'Delete Session tokens' }));
    expect(api.callsTo('DELETE', `/api/v1/assets/${ASSET_ID}`)).toHaveLength(0);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.callsTo('DELETE', `/api/v1/assets/${ASSET_ID}`)).toHaveLength(1));
    expect(await within(assets).findByText(/No assets yet/)).toBeTruthy();
  });
});

describe('assumptions', () => {
  it('adds, edits and deletes an assumption', async () => {
    const user = userEvent.setup();
    const added = assumption({ id: 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2', statement: 'Staff are trusted.' });
    const { api, state } = open({
      extra: {
        'POST /api/v1/threat-models/:id/assumptions': () => {
          state.assumptions = [...state.assumptions, added];
          return json(201, added);
        },
        'PATCH /api/v1/assumptions/:id': () => json(200, assumption({ statement: 'Edited.' })),
        'DELETE /api/v1/assumptions/:id': () => {
          state.assumptions = [added];
          return json(204);
        },
      },
    });
    const section = await assumptionsSection();
    await user.click(within(section).getByRole('button', { name: 'Add assumption' }));
    await user.type(within(section).getByLabelText('Statement'), 'Staff are trusted.');
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/assumptions`)).toHaveLength(1));
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL_ID}/assumptions`)[0]?.body).toEqual({ statement: 'Staff are trusted.' });

    await user.click(within(section).getByRole('button', { name: 'Edit The database is not exposed.' }));
    await user.clear(within(section).getByLabelText('Statement'));
    await user.type(within(section).getByLabelText('Statement'), 'Edited.');
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.callsTo('PATCH', `/api/v1/assumptions/${ASSUMPTION_ID}`)).toHaveLength(1));
    expect(api.callsTo('PATCH', `/api/v1/assumptions/${ASSUMPTION_ID}`)[0]?.body).toEqual({ statement: 'Edited.' });

    await user.click(within(section).getByRole('button', { name: 'Delete The database is not exposed.' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.callsTo('DELETE', `/api/v1/assumptions/${ASSUMPTION_ID}`)).toHaveLength(1));
  });

  it('shows the API’s refusal of a full section beside the form', async () => {
    const user = userEvent.setup();
    open({ extra: { 'POST /api/v1/threat-models/:id/assumptions': () => json(400, { error: 'A threat model can hold at most 200 assumptions' }) } });
    const section = await assumptionsSection();
    await user.click(within(section).getByRole('button', { name: 'Add assumption' }));
    await user.type(within(section).getByLabelText('Statement'), 'One too many.');
    await user.click(within(section).getByRole('button', { name: 'Save' }));
    expect((await within(section).findByRole('alert')).textContent).toContain('at most 200 assumptions');
  });
});

describe('provenance (FR-017)', () => {
  const mark = (target: { kind: string; id: string }, rationale: string) => ({
    id: `93939393-9393-4393-8393-93939393939${target.kind === 'asset' ? '1' : '2'}`,
    target,
    flag: null,
    rationale,
    accepted_by: { id: 7, username: 'ada' },
    accepted_at: NOW,
    citations: [citation()],
  });

  it('shows where an accepted asset and an accepted assumption came from, and nothing for one a person created', async () => {
    const other = asset({ id: 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', name: 'By hand', holder_ids: [] });
    open({
      assets: [asset(), other],
      provenance: [mark({ kind: 'asset', id: ASSET_ID }, 'The tokens are in the design.'), mark({ kind: 'assumption', id: ASSUMPTION_ID }, 'The design relies on it.')],
    });
    const assets = await assetsSection();
    const notices = await within(assets).findAllByRole('region', { name: 'Where this came from' });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toContain('The tokens are in the design.');
    const mine = within(assets).getByRole('heading', { name: 'By hand' }).closest('li') as HTMLElement;
    expect(within(mine).queryByRole('region', { name: 'Where this came from' })).toBeNull();
    expect((await within(await assumptionsSection()).findByRole('region', { name: 'Where this came from' })).textContent).toContain('The design relies on it.');
  });
});

