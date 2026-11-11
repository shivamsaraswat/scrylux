import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { PropertiesPanel } from './PropertiesPanel.js';
import { eid, el, fakeEditor, MODEL, renderWithEditor } from './test-helpers.js';
import { citation, installFakeApi, json } from '../test-utils.js';

// FR-013, FR-014, FR-006, contracts/ui.md "Properties panel" (the parts US1 needs).

const nodes = [el(1, { type: 'process', name: 'API' }), el(2, { type: 'data_store', name: 'DB' })];
const flowElement = el(3, { type: 'data_flow', name: 'Query', layout: null, source_element_id: eid(1), target_element_id: eid(2) });

function open(selected: number, extra: Parameters<typeof fakeEditor>[0] = {}) {
  const editor = fakeEditor({ elements: [...nodes, flowElement], selectedIds: [eid(selected)], ...extra });
  renderWithEditor(<PropertiesPanel />, editor);
  return editor;
}

describe('with nothing selected', () => {
  it('says to select an element', () => {
    renderWithEditor(<PropertiesPanel />, fakeEditor({ elements: nodes }));
    expect(screen.getByRole('complementary', { name: 'Properties' })).toBeTruthy();
    expect(screen.getByText('Select an element to see its properties')).toBeTruthy();
  });

  it('says the same for two selected elements', () => {
    renderWithEditor(<PropertiesPanel />, fakeEditor({ elements: nodes, selectedIds: [eid(1), eid(2)] }));
    expect(screen.getByText('Select an element to see its properties')).toBeTruthy();
  });
});

describe('the name', () => {
  it('shows the name and saves a change when the field is left (blur)', async () => {
    const editor = open(1);
    const user = userEvent.setup();
    const field = screen.getByLabelText('Name');
    expect((field as HTMLInputElement).value).toBe('API');

    await user.clear(field);
    await user.type(field, 'Gateway');
    await user.tab();

    expect(editor.apply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(editor.apply).mock.calls[0]?.[0].ops).toEqual([{ op: 'update', id: eid(1), changes: { name: 'Gateway' } }]);
  });

  it('saves a change on Enter, and does not save again when the field is then left', async () => {
    const editor = open(1);
    const user = userEvent.setup();
    const field = screen.getByLabelText('Name');

    await user.clear(field);
    await user.type(field, 'Gateway{Enter}');
    await user.tab();

    expect(editor.apply).toHaveBeenCalledTimes(1);
  });

  it('saves nothing when the name was not changed, or only changed by spaces', async () => {
    const editor = open(1);
    const user = userEvent.setup();
    const field = screen.getByLabelText('Name');

    await user.click(field);
    await user.tab();
    await user.click(field);
    await user.type(field, '   ');
    await user.tab();

    expect(editor.apply).not.toHaveBeenCalled();
  });

  it.each([
    ['blank', '   ', 'must not be empty'],
    ['over 200 characters', 'x'.repeat(201), 'must be at most 200 characters'],
  ])('shows an error next to the field and saves nothing for a name that is %s (FR-014)', async (_label, value, message) => {
    const editor = open(1);
    const user = userEvent.setup({ delay: null });
    const field = screen.getByLabelText('Name');

    await user.clear(field);
    await user.type(field, value);
    await user.tab();

    expect(editor.apply).not.toHaveBeenCalled();
    expect(screen.getByText(message)).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('puts the cursor in the name field when asked to, once', () => {
    const editor = open(1, { focusNameFor: eid(1) });
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    expect(editor.clearNameFocus).toHaveBeenCalled();
  });
});

describe('the type', () => {
  it('lets a node become another node type, keeping its name', async () => {
    const editor = open(1);
    const user = userEvent.setup();
    const select = screen.getByLabelText<HTMLSelectElement>('Type');
    expect([...select.options].map((o) => o.value)).toEqual(['external_entity', 'process', 'data_store']);
    expect(select.value).toBe('process');

    await user.selectOptions(select, 'data_store');

    expect(vi.mocked(editor.apply).mock.calls[0]?.[0].ops).toEqual([{ op: 'update', id: eid(1), changes: { type: 'data_store' } }]);
  });

  it('is not offered for a data flow or a trust boundary, which cannot change type', () => {
    open(3);
    expect(screen.queryByLabelText('Type')).toBeNull();
  });
});

describe('a data flow', () => {
  it('shows its source and target as read-only names', () => {
    open(3);
    expect(screen.getByText('Source').nextElementSibling?.textContent).toBe('API');
    expect(screen.getByText('Target').nextElementSibling?.textContent).toBe('DB');
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });
});

describe('the trust boundary of an element (FR-012, US2)', () => {
  const vpc = el(10, { type: 'trust_boundary', name: 'VPC', layout: { x: 0, y: 0, width: 600, height: 400 } });
  const subnet = el(11, { type: 'trust_boundary', name: 'Subnet', layout: { x: 50, y: 50, width: 300, height: 200 }, parent_boundary_id: eid(10) });
  const other = el(12, { type: 'trust_boundary', name: 'DMZ', layout: { x: 900, y: 0, width: 300, height: 200 } });
  const member = el(1, { type: 'process', name: 'API', layout: { x: 20, y: 20 }, parent_boundary_id: eid(10) });
  const free = el(2, { type: 'data_store', name: 'DB', layout: { x: 2000, y: 2000 } });

  function select(target: ReturnType<typeof el>, extra: ReturnType<typeof el>[] = []) {
    const editor = fakeEditor({ elements: [vpc, subnet, other, member, free, ...extra], selectedIds: [target.id] });
    renderWithEditor(<PropertiesPanel />, editor);
    return editor;
  }

  it('offers None and every boundary for a node, showing the one it is in', () => {
    select(member);
    const field = screen.getByLabelText<HTMLSelectElement>('Trust boundary');
    expect([...field.options].map((o) => o.textContent)).toEqual(['None', 'VPC', 'Subnet', 'DMZ']);
    expect(field.value).toBe(eid(10));
  });

  it('shows None for an element that is in no boundary', () => {
    select(free);
    expect(screen.getByLabelText<HTMLSelectElement>('Trust boundary').value).toBe('');
  });

  it('leaves out a boundary itself and the boundaries inside it', () => {
    select(vpc);
    const field = screen.getByLabelText<HTMLSelectElement>('Trust boundary');
    expect([...field.options].map((o) => o.textContent)).toEqual(['None', 'DMZ']);
  });

  it('makes the element a member, placed inside the boundary, when one is chosen', async () => {
    const editor = select(free);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Trust boundary'), eid(12));

    const op = vi.mocked(editor.apply).mock.calls[0]?.[0].ops[0];
    expect(op).toMatchObject({ op: 'update', id: eid(2), changes: { parent_boundary_id: eid(12) } });
    const layout = op?.op === 'update' ? (op.changes.layout as { x: number; y: number }) : { x: -1, y: -1 };
    expect(layout.x).toBeGreaterThanOrEqual(0);
    expect(layout.y).toBeGreaterThanOrEqual(0);
    expect(layout.x + 140).toBeLessThanOrEqual(300);
    expect(layout.y + 60).toBeLessThanOrEqual(200);
  });

  it('takes the element out of its boundary on None, keeping its place on the diagram', async () => {
    const editor = select(member);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Trust boundary'), '');

    expect(vi.mocked(editor.apply).mock.calls[0]?.[0].ops).toEqual([
      { op: 'update', id: eid(1), changes: { parent_boundary_id: null, layout: { x: 20, y: 20 } } },
    ]);
  });

  it('is shown for a boundary too, and not for a data flow', () => {
    select(subnet);
    expect(screen.getByLabelText('Trust boundary')).toBeTruthy();
    document.body.innerHTML = '';
    select(flowElement);
    expect(screen.queryByLabelText('Trust boundary')).toBeNull();
  });
});

describe('deleting the selected element', () => {
  it('has a "Delete element" button that asks to delete it', async () => {
    const editor = open(1);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Delete element' }));
    expect(editor.requestDelete).toHaveBeenCalledWith(eid(1));
    expect(editor.apply).not.toHaveBeenCalled();
  });
});

// Where an accepted element came from (Phase 3 Milestone 5, US6, FR-017): the panel shows it for the selected element, and for the flags an accept set, and nothing for
// an element a person drew.
describe('provenance', () => {
  const marks = (flag: string | null, target = eid(1)) => ({
    id: `92929292-9292-4292-8292-92929292929${flag === null ? '1' : '2'}`,
    target: { kind: 'element', id: target },
    flag,
    rationale: 'The API serves the web application.',
    accepted_by: { id: 7, username: 'ada' },
    accepted_at: '2026-11-10T09:00:00.000Z',
    citations: [citation()],
  });

  function openWith(records: unknown[]) {
    installFakeApi({ 'GET /api/v1/threat-models/:id/provenance': () => json(200, records) });
    // A citation links to its source, so the panel needs a router here.
    renderWithEditor(
      <MemoryRouter>
        <PropertiesPanel />
      </MemoryRouter>,
      fakeEditor({ elements: [...nodes, flowElement], selectedIds: [eid(1)] }),
    );
  }

  it('shows that the selected element was proposed by AI and accepted, why, and what it cited', async () => {
    openWith([marks(null)]);
    const notice = await screen.findByRole('region', { name: 'Where this came from' });
    expect(notice.textContent).toMatch(/Proposed by AI, accepted by ada on /);
    expect(within(notice).getByText('design.md')).toBeTruthy();
    void MODEL;
  });

  it('marks, for an element drawn by hand and partly filled in by an accept, only the flags the accept set', async () => {
    openWith([marks('internet_facing')]);
    const notice = await screen.findByRole('region', { name: 'Where this came from' });
    expect(within(notice).getByRole('heading', { name: 'Flags set from the documents' })).toBeTruthy();
    // The element's own line is a <strong> straight under the notice; a flag's is a muted line inside its list item. The date's format depends on the locale, so no text is compared.
    expect(notice.querySelector(':scope > p > strong')).toBeNull();
  });

  it('shows nothing for another element’s mark, or for an element a person drew', async () => {
    openWith([marks(null, eid(2))]);
    await waitFor(() => expect(screen.getByLabelText('Name')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: 'Where this came from' })).toBeNull();
  });
});
