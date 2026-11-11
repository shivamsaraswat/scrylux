import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appRoutes } from '../App.js';
import { MODEL_ID, installFakeApi, json, project, threatModel } from '../test-utils.js';

// What the import left out, on the page of the threat model it created (spec FR-013a, FR-016, US1/AC2, US4/AC2). The
// import passes its summary in the navigation state; the page shows it once and drops it from the address's history entry.
afterEach(() => {
  vi.unstubAllGlobals();
});

const notes = [
  { path: 'file.detail.diagrams.0.cells.3', kind: 'not_imported.boundary_line', label: 'Perimeter' },
  { path: 'file.components.1', kind: 'mapped.component_type', label: 'Web Service', detail: 'process' },
];
const importSummary = (list: unknown[] = notes) => ({
  models: [{ name: 'Checkout v2', name_issue: null, status: 'draft', elements: 5, threats: 2, mitigations: 1, assets: 0, assumptions: 0 }],
  notes: list,
});

function renderModelPage(state: unknown) {
  installFakeApi({
    'GET /api/v1/threat-models/:id': () => json(200, threatModel()),
    'GET /api/v1/projects/:id': () => json(200, project()),
    'GET /api/v1/threat-models/:id/elements': () => json(200, []),
    'GET /api/v1/threat-models/:id/threats': () => json(200, []),
    'GET /api/v1/threat-models/:id/mitigations': () => json(200, []),
  });
  const router = createMemoryRouter(appRoutes, { initialEntries: [{ pathname: `/threat-models/${MODEL_ID}`, state }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const region = () => screen.findByRole('region', { name: 'What the import left out' });

describe('ThreatModelPage after an import that left something out', () => {
  it('shows how many parts were left out and each one, grouped as in the preview', async () => {
    renderModelPage({ importSummary: importSummary() });
    const shown = await region();
    expect(within(shown).getByText("2 parts of this file weren't carried over or were changed to fit.")).toBeTruthy();
    expect(within(shown).getByText('Trust boundary lines (not imported)')).toBeTruthy();
    expect(within(shown).getByText('Perimeter')).toBeTruthy();
    expect(within(shown).getByText('file.components.1').tagName).toBe('CODE');
  });

  it('closes on Dismiss and leaves the page as it was', async () => {
    renderModelPage({ importSummary: importSummary() });
    const shown = await region();
    await userEvent.click(within(shown).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'What the import left out' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Checkout v2' })).toBeTruthy();
  });

  it('moves the focus to the page title when it closes, so it is not lost with the button', async () => {
    renderModelPage({ importSummary: importSummary() });
    const shown = await region();
    await userEvent.click(within(shown).getByRole('button', { name: 'Dismiss' }));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Checkout v2' }));
  });

  it('stays while the user moves between the views of the threat model', async () => {
    renderModelPage({ importSummary: importSummary() });
    await region();
    await userEvent.click(screen.getByRole('link', { name: 'Diagram' }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'Diagram' }).getAttribute('aria-current')).toBe('page'));
    expect(screen.getByRole('region', { name: 'What the import left out' })).toBeTruthy();
  });

  it('is dropped from the history entry, so a reload shows none', async () => {
    const router = renderModelPage({ importSummary: importSummary() });
    await region();
    await waitFor(() => expect(router.state.location.state).toBeNull());
    expect(router.state.location.pathname).toBe(`/threat-models/${MODEL_ID}`);
  });

  it.each([
    ['no navigation state', null],
    ['state without a summary', { other: 1 }],
    ['a summary that is not one', { importSummary: { notes: 'x' } }],
    ['nothing left out', { importSummary: importSummary([]) }],
  ])('shows no region for %s', async (_label, state) => {
    renderModelPage(state);
    expect(await screen.findByRole('heading', { name: 'Checkout v2' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'What the import left out' })).toBeNull();
  });

  it('shows hostile names as text', async () => {
    renderModelPage({ importSummary: importSummary([{ path: 'file.x', kind: 'not_imported.asset', label: '<img src=x onerror=alert(1)>' }]) });
    const shown = await region();
    expect(within(shown).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(shown.querySelector('img')).toBeNull();
  });
});
