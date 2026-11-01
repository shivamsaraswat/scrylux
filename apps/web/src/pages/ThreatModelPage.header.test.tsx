import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_ID, PROJECT_ID, installFakeApi, json, project, renderApp, threatModel } from '../test-utils.js';

// The threat model page's header: its details, status and delete (contracts/ui.md, "Threat model
// page"; spec FR-007, FR-008, FR-014). The threat table is covered with US2.
afterEach(() => {
  vi.unstubAllGlobals();
});

function handlers(model = threatModel()) {
  return {
    'GET /api/v1/threat-models/:id': () => json(200, model),
    'GET /api/v1/projects/:id': () => json(200, project()),
    // The threats section has its own tests; here its three reads just come back empty.
    'GET /api/v1/threat-models/:id/elements': () => json(200, []),
    'GET /api/v1/threat-models/:id/threats': () => json(200, []),
    'GET /api/v1/threat-models/:id/mitigations': () => json(200, []),
  };
}

describe('ThreatModelPage header', () => {
  it('shows the name, a link to its project, and the methodology as read-only text', async () => {
    installFakeApi(handlers());
    renderApp(`/threat-models/${MODEL_ID}`);

    expect(await screen.findByRole('heading', { name: 'Checkout v2' })).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Payments' })).getAttribute('href')).toBe(`/projects/${PROJECT_ID}`);
    expect(screen.getByText('STRIDE')).toBeTruthy();
    expect(screen.queryByLabelText('Methodology')).toBeNull();
  });

  it('offers draft, in review and approved, and lets any status be set at any time, backwards too', async () => {
    const api = installFakeApi({
      ...handlers(),
      'PATCH /api/v1/threat-models/:id': ({ body }) => json(200, threatModel(body as Record<string, unknown>)),
    });
    renderApp(`/threat-models/${MODEL_ID}`);
    const select = await screen.findByLabelText<HTMLSelectElement>('Status');
    expect([...select.options].map((o) => o.textContent)).toEqual(['draft', 'in review', 'approved']);

    await userEvent.selectOptions(select, 'approved');
    await userEvent.selectOptions(select, 'draft');

    await waitFor(() => expect(api.callsTo('PATCH', `/api/v1/threat-models/${MODEL_ID}`)).toHaveLength(2));
    expect(api.callsTo('PATCH', `/api/v1/threat-models/${MODEL_ID}`).map((c) => c.body)).toEqual([
      { status: 'approved' },
      { status: 'draft' },
    ]);
  });

  it('shows the server’s state, not the attempted one, when the status change is rejected', async () => {
    installFakeApi({
      ...handlers(),
      'PATCH /api/v1/threat-models/:id': () => json(500, { error: 'Internal server error' }),
    });
    renderApp(`/threat-models/${MODEL_ID}`);
    const select = await screen.findByLabelText<HTMLSelectElement>('Status');

    await userEvent.selectOptions(select, 'approved');

    expect(await screen.findByText('Internal server error')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Status').value).toBe('draft'));
  });

  it('renames through Edit, sending only the name', async () => {
    const api = installFakeApi({
      ...handlers(),
      'PATCH /api/v1/threat-models/:id': () => json(200, threatModel({ name: 'Checkout v3' })),
    });
    renderApp(`/threat-models/${MODEL_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Checkout v3');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.callsTo('PATCH', `/api/v1/threat-models/${MODEL_ID}`)).toHaveLength(1));
    expect(api.callsTo('PATCH', `/api/v1/threat-models/${MODEL_ID}`)[0]?.body).toEqual({ name: 'Checkout v3' });
  });

  it('asks before deleting, then returns to the project page', async () => {
    const api = installFakeApi({
      ...handlers(),
      'DELETE /api/v1/threat-models/:id': () => new Response(null, { status: 204 }),
      'GET /api/v1/projects/:id/threat-models': () => json(200, []),
    });
    renderApp(`/threat-models/${MODEL_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(
      screen.getByText('Delete threat model "Checkout v2"? This permanently deletes its elements, threats, mitigations and documents.'),
    ).toBeTruthy();
    const dialog = document.querySelector('dialog') as HTMLElement;
    await userEvent.click(dialog.querySelector('button.danger') as HTMLElement);

    expect(await screen.findByText('No threat models yet.')).toBeTruthy();
    expect(api.callsTo('DELETE', `/api/v1/threat-models/${MODEL_ID}`)).toHaveLength(1);
  });

  it('says "This item no longer exists." and refetches when a write finds it gone', async () => {
    let loads = 0;
    installFakeApi({
      'GET /api/v1/threat-models/:id': () => {
        loads += 1;
        return loads === 1 ? json(200, threatModel()) : json(404, { error: 'Not found' });
      },
      'GET /api/v1/projects/:id': () => json(200, project()),
      'GET /api/v1/threat-models/:id/elements': () => json(200, []),
      'GET /api/v1/threat-models/:id/threats': () => json(200, []),
      'GET /api/v1/threat-models/:id/mitigations': () => json(200, []),
      'PATCH /api/v1/threat-models/:id': () => json(404, { error: 'Not found' }),
    });
    renderApp(`/threat-models/${MODEL_ID}`);
    await userEvent.selectOptions(await screen.findByLabelText('Status'), 'approved');

    expect(await screen.findByText('This item no longer exists.')).toBeTruthy();
    await waitFor(() => expect(loads).toBeGreaterThan(1));
  });

  it('shows the not-found page when the threat model does not exist', async () => {
    installFakeApi({ 'GET /api/v1/threat-models/:id': () => json(404, { error: 'Not found' }) });
    renderApp(`/threat-models/${MODEL_ID}`);
    expect(await screen.findByText("This page doesn't exist.")).toBeTruthy();
  });

  it('shows the not-found page, with no request, for an id that is not a UUID', async () => {
    const api = installFakeApi({});
    renderApp('/threat-models/not-a-uuid');
    expect(await screen.findByText("This page doesn't exist.")).toBeTruthy();
    expect(api.calls.filter((c) => c.path.startsWith('/api/v1'))).toHaveLength(0);
  });
});
