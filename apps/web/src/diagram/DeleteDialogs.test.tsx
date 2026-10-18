import type { ThreatRecord } from '@scrylux/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteDialogs } from './DeleteDialogs.js';
import { planDelete } from './delete-plan.js';
import { MODEL, eid, el, fakeEditor, renderWithEditor } from './test-helpers.js';
import { installFakeApi, json, threat as makeThreat } from '../test-utils.js';

// FR-021, FR-022, FR-023: a delete says what else it takes with it, and is refused while threats are linked.

const api = el(1, { type: 'process', name: 'API' });
const db = el(2, { type: 'data_store', name: 'DB' });
const lonely = el(3, { type: 'process', name: 'Lonely' });
const vpc = el(4, { type: 'trust_boundary', name: 'VPC', layout: { x: 0, y: 0, width: 300, height: 200 } });
const query = el(5, { type: 'data_flow', name: 'Query', layout: null, source_element_id: eid(1), target_element_id: eid(2) });
const reply = el(6, { type: 'data_flow', name: 'Reply', layout: null, source_element_id: eid(2), target_element_id: eid(1) });
const all = [api, db, lonely, vpc, query, reply];

// The shared fixture's literals are widened to string; planDelete takes the real record type.
const threat = (overrides: Record<string, unknown> = {}) => makeThreat(overrides) as ThreatRecord;
const linked = (elementId: string, title: string) => threat({ id: crypto.randomUUID(), element_id: elementId, title });

describe('planDelete', () => {
  it('deletes a flow, a boundary and a node without flows at once', () => {
    expect(planDelete(all, [], eid(5))).toEqual({ kind: 'now' });
    expect(planDelete(all, [], eid(4))).toEqual({ kind: 'now' });
    expect(planDelete(all, [], eid(3))).toEqual({ kind: 'now' });
  });

  it('asks about a node that has flows, counting them in both directions', () => {
    expect(planDelete(all, [], eid(1))).toEqual({ kind: 'confirm', flows: 2 });
    expect(planDelete(all, [], eid(2))).toEqual({ kind: 'confirm', flows: 2 });
  });

  it('refuses while a threat is linked to the element, and lists it with the element it is on', () => {
    const plan = planDelete(all, [linked(eid(1), 'Token theft')], eid(1));
    expect(plan).toEqual({ kind: 'blocked', threats: [{ id: expect.any(String) as string, title: 'Token theft', elementName: 'API' }] });
  });

  it('refuses while a threat is linked to a flow that would go with the node', () => {
    const plan = planDelete(all, [linked(eid(5), 'Eavesdropping')], eid(2));
    expect(plan).toMatchObject({ kind: 'blocked', threats: [{ title: 'Eavesdropping', elementName: 'Query' }] });
  });

  it('is not held up by threats on other elements, or by model-level threats', () => {
    expect(planDelete(all, [linked(eid(3), 'Elsewhere'), threat({ element_id: null })], eid(1))).toEqual({ kind: 'confirm', flows: 2 });
  });
});

function open(editorOverrides: Parameters<typeof fakeEditor>[0], threats: unknown[] = []) {
  installFakeApi({ [`GET /api/v1/threat-models/${MODEL}/threats`]: () => json(200, threats) });
  const editor = fakeEditor({ elements: all, ...editorOverrides });
  renderWithEditor(
    <MemoryRouter>
      <DeleteDialogs />
    </MemoryRouter>,
    editor,
  );
  return editor;
}
const lastOps = (editor: ReturnType<typeof fakeEditor>) => vi.mocked(editor.apply).mock.calls.at(-1)?.[0].ops;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DeleteDialogs', () => {
  it('shows nothing when nothing is to be deleted', () => {
    const editor = open({});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(editor.apply).not.toHaveBeenCalled();
  });

  it('deletes a flow at once, with no question', async () => {
    const editor = open({ deleteRequest: eid(5) });
    await waitFor(() => expect(editor.apply).toHaveBeenCalledTimes(1));
    expect(lastOps(editor)).toEqual([{ op: 'delete', id: eid(5) }]);
    expect(editor.clearDeleteRequest).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deletes a trust boundary at once: what it holds stays', async () => {
    const editor = open({ deleteRequest: eid(4) });
    await waitFor(() => expect(editor.apply).toHaveBeenCalledTimes(1));
    expect(lastOps(editor)).toEqual([{ op: 'delete', id: eid(4) }]);
  });

  it('asks first about a node with flows, naming how many, and deletes only when confirmed', async () => {
    const editor = open({ deleteRequest: eid(1) });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe('Delete API and its 2 data flows?');
    expect(editor.apply).not.toHaveBeenCalled();

    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(lastOps(editor)).toEqual([{ op: 'delete', id: eid(1) }]);
    expect(editor.clearDeleteRequest).toHaveBeenCalled();
  });

  it('uses the singular for one flow', async () => {
    open({ deleteRequest: eid(1), elements: [api, db, query] });
    expect((await screen.findByRole('heading')).textContent).toBe('Delete API and its 1 data flow?');
  });

  it('does nothing when the question is answered with Cancel', async () => {
    const editor = open({ deleteRequest: eid(1) });
    await userEvent.setup().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(editor.apply).not.toHaveBeenCalled();
    expect(editor.clearDeleteRequest).toHaveBeenCalled();
  });

  it('refuses while threats are linked, listing them, and sends nothing', async () => {
    const editor = open({ deleteRequest: eid(1) }, [linked(eid(1), 'Token theft'), linked(eid(5), 'Eavesdropping')]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toBe("This element can't be deleted yet");
    expect(dialog.textContent).toContain('Token theft');
    expect(dialog.textContent).toContain('on API');
    expect(dialog.textContent).toContain('Eavesdropping');
    expect(dialog.textContent).toContain('on Query');
    expect(within(dialog).getByRole('link', { name: 'Open the Threats tab' }).getAttribute('href')).toBe(`/threat-models/${MODEL}`);
    expect(editor.apply).not.toHaveBeenCalled();

    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(editor.clearDeleteRequest).toHaveBeenCalled();
    expect(editor.apply).not.toHaveBeenCalled();
  });

  it('shows a threat title with markup as text', async () => {
    open({ deleteRequest: eid(1) }, [linked(eid(1), '<img src=x onerror=alert(1)>')]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('img')).toBeNull();
    expect(dialog.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
