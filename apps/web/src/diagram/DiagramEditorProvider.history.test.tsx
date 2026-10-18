import type { ElementRecord } from '@scrylux/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionContext, type SessionValue } from '../session/SessionProvider.js';
import { installFakeApi, json } from '../test-utils.js';
import { DiagramEditorProvider, useDiagramEditor, type DiagramEditor } from './DiagramEditorProvider.js';
import { applyOps, type BatchOp } from './operations.js';
import { MODEL, eid, el } from './test-helpers.js';

// FR-024 to FR-024d, and the spec edge case "Undo after a failed save": the editor keeps the session's
// history, undoes and redoes through the same queue as any other change, and never sends anything twice.

const session = { registerUnsavedWork: () => () => undefined } as unknown as SessionValue;

let editor: DiagramEditor;
function Probe() {
  const current = useDiagramEditor();
  useEffect(() => {
    editor = current;
  });
  return <p data-testid="names">{current.elements?.map((e) => e.name).join(',')}</p>;
}

// A server that applies each batch to its own copy, and lets a test say how the next ones go.
function fakeServer(initial: ElementRecord[]) {
  const server = { elements: initial, batches: [] as BatchOp[][], respond: [] as (() => Response | Promise<Response>)[] };
  const api = installFakeApi({
    [`GET /api/v1/threat-models/${MODEL}/elements`]: () => json(200, server.elements),
    // The editor reads the threats too, for the open-threat counts (Phase 2 M4).
    [`GET /api/v1/threat-models/${MODEL}/threats`]: () => json(200, []),
    [`POST /api/v1/threat-models/${MODEL}/elements/batch`]: ({ body }) => {
      const ops = (body as { operations: BatchOp[] }).operations;
      const next = server.respond.shift();
      if (next) return next();
      server.batches.push(ops);
      const before = server.elements;
      server.elements = applyOps(MODEL, before, ops);
      const same = (a: ElementRecord, b: ElementRecord) => JSON.stringify({ ...a, updated_at: '' }) === JSON.stringify({ ...b, updated_at: '' });
      return json(200, {
        elements: server.elements.filter((e) => !before.some((old) => same(old, e))),
        deleted: before.filter((old) => !server.elements.some((e) => e.id === old.id)).map((old) => old.id),
      });
    },
  });
  return { server, api };
}

function Tabs({ children }: { children: React.ReactNode }) {
  const [onDiagram, setOnDiagram] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOnDiagram((on) => !on)}>
        switch tab
      </button>
      {onDiagram ? children : <p>threats tab</p>}
    </>
  );
}

function mount(key = 'a') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={session}>
        <DiagramEditorProvider key={key} threatModelId={MODEL}>
          <Tabs>
            <Probe />
          </Tabs>
        </DiagramEditorProvider>
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

const api1 = el(1, { name: 'API', layout: { x: 100, y: 50 } });
const rename = (to: string) => ({ label: `Rename API`, ops: [{ op: 'update', id: eid(1), changes: { name: to } }] as BatchOp[] });
const names = () => screen.getByTestId('names').textContent;
const saved = () => waitFor(() => expect(editor.status).toBe('saved'));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('undo and redo in the editor', () => {
  it('has nothing to undo or redo at first', async () => {
    fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));
    expect([editor.undoLabel, editor.redoLabel]).toEqual([null, null]);
  });

  it('undoes the latest action as one action, and redoes it', async () => {
    const { server } = fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));

    act(() => editor.apply(rename('Gateway')));
    await saved();
    expect(editor.undoLabel).toBe('Rename API');

    act(() => editor.undo());
    expect(names()).toBe('API'); // at once, before the server has answered
    await saved();
    expect(server.batches.at(-1)).toEqual([{ op: 'update', id: eid(1), changes: { name: 'API' } }]);
    expect([editor.undoLabel, editor.redoLabel]).toEqual([null, 'Rename API']);

    act(() => editor.redo());
    expect(names()).toBe('Gateway');
    await saved();
    expect(server.batches.at(-1)).toEqual([{ op: 'update', id: eid(1), changes: { name: 'Gateway' } }]);
    expect(server.elements[0]?.name).toBe('Gateway');
    expect([editor.undoLabel, editor.redoLabel]).toEqual(['Rename API', null]);
  });

  it('does nothing when there is nothing to undo or redo', async () => {
    const { server } = fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));
    act(() => editor.undo());
    act(() => editor.redo());
    await saved();
    expect(server.batches).toEqual([]);
  });

  it('forgets what could be redone when a new action is made', async () => {
    fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));
    act(() => editor.apply(rename('One')));
    await saved();
    act(() => editor.undo());
    await saved();
    expect(editor.redoLabel).not.toBeNull();

    act(() => editor.apply(rename('Two')));
    await saved();
    expect(editor.redoLabel).toBeNull();
  });

  it('keeps its history while the user is on the other tab, and starts empty in a new editor', async () => {
    fakeServer([api1]);
    const view = mount();
    await waitFor(() => expect(names()).toBe('API'));
    act(() => editor.apply(rename('Gateway')));
    await saved();

    act(() => screen.getByRole('button', { name: 'switch tab' }).click());
    expect(screen.getByText('threats tab')).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'switch tab' }).click());
    await waitFor(() => expect(names()).toBe('Gateway'));
    expect(editor.undoLabel).toBe('Rename API');

    view.unmount();
    fakeServer([api1]);
    mount('b');
    await waitFor(() => expect(names()).toBe('API'));
    expect([editor.undoLabel, editor.redoLabel]).toEqual([null, null]);
  });
});

describe('when the server refuses', () => {
  it('never keeps an action it refused, and says why', async () => {
    const { server } = fakeServer([api1]);
    server.respond.push(() => json(400, { error: 'Operation 1: name must be shorter' }));
    mount();
    await waitFor(() => expect(names()).toBe('API'));

    act(() => editor.apply(rename('Gateway')));
    await waitFor(() => expect(editor.notice).toContain('name must be shorter'));
    expect(names()).toBe('API');
    expect(editor.undoLabel).toBeNull();
  });

  it('drops an undo it refused, shows the reason, and changes nothing', async () => {
    const { server } = fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));
    act(() => editor.apply(rename('Gateway')));
    await saved();

    server.respond.push(() => json(400, { error: 'Operation 1: a threat model can hold at most 1000 elements' }));
    act(() => editor.undo());
    await waitFor(() => expect(editor.notice).toContain('at most 1000 elements'));
    await saved();
    expect([editor.undoLabel, editor.redoLabel]).toEqual([null, null]);
    expect(names()).toBe('Gateway');
  });

  it('drops an undo of an element that another session deleted, and reloads the diagram', async () => {
    const { server } = fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));
    act(() => editor.apply(rename('Gateway')));
    await saved();

    server.respond.push(() => json(404, { error: 'Operation 1: Element not found' }));
    act(() => editor.undo());
    await waitFor(() => expect(editor.notice).toContain('changed elsewhere'));
    await saved();
    expect([editor.undoLabel, editor.redoLabel]).toEqual([null, null]);
  });

  it('refuses to undo what would need more than 200 operations, and changes nothing', async () => {
    // One node with 200 flows: deleting it is one operation, but putting it back is 201.
    const hub = el(1, { name: 'Hub', layout: { x: 0, y: 0 } });
    const leaf = el(2, { name: 'Leaf', layout: { x: 400, y: 0 } });
    const flows = Array.from({ length: 200 }, (_, i) =>
      el(10 + i, { type: 'data_flow', name: `Flow ${i}`, layout: null, source_element_id: eid(1), target_element_id: eid(2) }),
    );
    const { server } = fakeServer([hub, leaf, ...flows]);
    mount();
    await waitFor(() => expect(names()).toContain('Hub'));

    act(() => editor.apply({ label: 'Delete Hub', ops: [{ op: 'delete', id: eid(1) }] }));
    await saved();
    const sent = server.batches.length;

    act(() => editor.undo());
    await waitFor(() => expect(editor.notice).toMatch(/too many|200/i));
    expect(server.batches).toHaveLength(sent);
    expect(names()).toBe('Leaf');
  });
});

describe('undo after a failed save', () => {
  it('shows the undone state at once, and after Retry sends the action and then its inverse, each once', async () => {
    const { server } = fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));

    // The first save cannot reach the server.
    server.respond.push(() => Promise.reject(new TypeError('Failed to fetch')));
    act(() => editor.apply(rename('Gateway')));
    await waitFor(() => expect(editor.status).toBe('failed'));
    expect(names()).toBe('Gateway');

    act(() => editor.undo());
    expect(names()).toBe('API');
    expect(editor.pendingCount).toBe(2);
    expect(server.batches).toEqual([]);

    act(() => editor.retry());
    await saved();
    expect(server.batches).toEqual([
      [{ op: 'update', id: eid(1), changes: { name: 'Gateway' } }],
      [{ op: 'update', id: eid(1), changes: { name: 'API' } }],
    ]);
    expect(server.elements[0]?.name).toBe('API');
    expect(names()).toBe('API');
  });
});

// Phase 2 / Milestone 4, spec edge case "Undo after linking a threat": a threat added to an element makes undoing
// that element's creation a delete of an element with a linked threat, which the server refuses.
describe('undo after a threat was linked to a new element', () => {
  it('is refused as any such delete is: the notice shows, the step is dropped, the threats are read again, and the element stays', async () => {
    const { server, api } = fakeServer([api1]);
    mount();
    await waitFor(() => expect(names()).toBe('API'));

    const cache = eid(50);
    act(() => editor.apply({ label: 'Add Cache', ops: [{ op: 'create', element: { id: cache, type: 'process', name: 'Cache', layout: { x: 300, y: 50 } } }] }));
    await saved();
    expect(names()).toBe('API,Cache');
    const readsBefore = api.callsTo('GET', `/api/v1/threat-models/${MODEL}/threats`).length;

    server.respond.push(() =>
      json(409, { error: 'This element still has threats, or data flows that would be deleted with it have threats; delete those threats first' }),
    );
    act(() => editor.undo());
    await waitFor(() => expect(editor.notice).toContain('That change was not saved: This element still has threats'));
    await saved();

    expect([editor.undoLabel, editor.redoLabel]).toEqual([null, null]);
    expect(names()).toBe('API,Cache');
    await waitFor(() => expect(api.callsTo('GET', `/api/v1/threat-models/${MODEL}/threats`).length).toBeGreaterThan(readsBefore));
  });
});
