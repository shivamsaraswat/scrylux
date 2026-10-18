import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagramEditorContext } from '../diagram/DiagramEditorProvider.js';
import { MODEL, el, fakeEditor } from '../diagram/test-helpers.js';
import { installFakeApi, json } from '../test-utils.js';
import { GenerateThreats } from './GenerateThreats.js';

// The generate bar (contracts/web-ui.md; spec FR-001, FR-004, FR-015, FR-017, US1 scenarios 6-9).
afterEach(() => {
  vi.unstubAllGlobals();
});

const GENERATE = `POST /api/v1/threat-models/:id/threats/generate`;
const result = (over: Record<string, unknown> = {}) => ({ created: 3, existing: 0, newly_stale: 0, no_longer_stale: 0, skipped_elements: [], ...over });

function setup(handlers: Parameters<typeof installFakeApi>[0], editor = fakeEditor()) {
  const api = installFakeApi({
    [`GET /api/v1/threat-models/${MODEL}/threats`]: () => json(200, []),
    [`GET /api/v1/threat-models/${MODEL}/mitigations`]: () => json(200, []),
    ...handlers,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DiagramEditorContext.Provider value={editor}>
        <GenerateThreats threatModelId={MODEL} />
      </DiagramEditorContext.Provider>
    </QueryClientProvider>,
  );
  return { api, client, editor };
}

const click = async () => userEvent.click(screen.getByRole('button', { name: 'Generate threats' }));
const status = () => screen.getByRole('status');

describe('GenerateThreats', () => {
  it('has the button, and sends a POST with the body {} and nothing else', async () => {
    const { api } = setup({ [GENERATE]: () => json(200, result()) });
    await click();
    await waitFor(() => expect(status().textContent).toContain('Generated threats'));
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL}/threats/generate`)[0]?.body).toEqual({});
  });

  it('is disabled while the request is pending and says it is generating', async () => {
    let release: (response: Response) => void = () => undefined;
    setup({ [GENERATE]: () => new Promise<Response>((resolve) => (release = resolve)) });
    await click();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Generate threats' }).disabled).toBe(true);
    expect(status().textContent).toBe('Generating threats…');
    release(json(200, result()));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Generate threats' }).disabled).toBe(false));
  });

  it('reports the counts, and invalidates the threats and mitigations so the table shows what the server holds', async () => {
    const { client } = setup({ [GENERATE]: () => json(200, result()) });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await click();
    await waitFor(() =>
      expect(status().textContent).toBe('Generated threats: 3 created, 0 already existed (of which 0 no longer stale), 0 newly stale.'),
    );
    await waitFor(() => {
      const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      expect(keys).toContainEqual(['threats', MODEL]);
      expect(keys).toContainEqual(['mitigations', MODEL]);
    });
  });

  it('invalidates them after a failure too: a lost answer may still have stored the threats', async () => {
    const { client } = setup({ [GENERATE]: () => Promise.reject(new TypeError('network')) });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await click();
    await waitFor(() => expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['threats', MODEL]));
  });

  it('says there is nothing to generate when every count is zero', async () => {
    setup({ [GENERATE]: () => json(200, result({ created: 0 })) });
    await click();
    await waitFor(() => expect(status().textContent).toBe('No threats to generate: no rule applies to the elements of this diagram.'));
  });

  it('names the skipped elements and how to clean them up, and shows an unknown id as gone', async () => {
    const gone = '00000000-0000-4000-8000-0000000000ff';
    setup(
      { [GENERATE]: () => json(200, result({ skipped_elements: ['00000000-0000-4000-8000-000000000001', gone] })) },
      fakeEditor({ elements: [el(1, { name: 'Legacy API' })] }),
    );
    await click();
    await waitFor(() => expect(status().textContent).toContain('2 element(s) skipped'));
    expect(status().textContent).toContain('Legacy API, an element that no longer exists');
    expect(status().textContent).toContain('Change any property of each in the diagram to clean it up, then generate again.');
  });

  it('shows the server message for a 4xx', async () => {
    setup({ [GENERATE]: () => json(404, { error: 'Threat model not found' }) });
    await click();
    await waitFor(() => expect(status().textContent).toBe('Threat model not found'));
  });

  it('says nothing was saved for the app’s own 500', async () => {
    setup({ [GENERATE]: () => json(500, { error: 'Internal server error' }) });
    await click();
    await waitFor(() => expect(status().textContent).toBe('Generating threats failed. Nothing was saved. Try again.'));
  });

  const unknownOutcome =
    'The connection was lost before Scrylux answered, so the threats may or may not have been generated. Generating again is safe: it never creates duplicates.';

  it.each([
    ['a network error', () => Promise.reject(new TypeError('network'))],
    ['a proxy’s 502 page', () => Promise.resolve(new Response('<html>bad gateway</html>', { status: 502 }))],
    ['a 500 that is not the app’s JSON', () => Promise.resolve(new Response('<html>oops</html>', { status: 500 }))],
  ])('says the outcome is unknown after %s', async (_name, respond) => {
    setup({ [GENERATE]: respond });
    await click();
    await waitFor(() => expect(status().textContent).toBe(unknownOutcome));
  });

  it('waits for pending diagram saves before it sends anything', async () => {
    let settle: (value: 'saved') => void = () => undefined;
    const whenSettled = vi.fn(() => new Promise<'saved'>((resolve) => (settle = resolve)));
    const { api } = setup({ [GENERATE]: () => json(200, result()) }, fakeEditor({ pendingCount: 1, whenSettled }));
    await click();
    expect(status().textContent).toBe('Saving your diagram changes first…');
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL}/threats/generate`)).toHaveLength(0);
    settle('saved');
    await waitFor(() => expect(status().textContent).toContain('Generated threats'));
  });

  it('does not send when the threat model was deleted while changes were pending, and can be used again afterwards', async () => {
    const { api } = setup({ [GENERATE]: () => json(200, result()) }, fakeEditor({ pendingCount: 1, whenSettled: () => Promise.resolve('gone') }));
    await click();
    await waitFor(() => expect(status().textContent).toBe('This threat model no longer exists.'));
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL}/threats/generate`)).toHaveLength(0);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Generate threats' }).disabled).toBe(false);
  });

  it('does not send when the diagram changes could not be saved', async () => {
    const { api } = setup({ [GENERATE]: () => json(200, result()) }, fakeEditor({ whenSettled: () => Promise.resolve('failed') }));
    await click();
    await waitFor(() =>
      expect(status().textContent).toBe('Your diagram has changes that could not be saved. Save them (Retry) before generating threats.'),
    );
    expect(api.callsTo('POST', `/api/v1/threat-models/${MODEL}/threats/generate`)).toHaveLength(0);
  });
});
