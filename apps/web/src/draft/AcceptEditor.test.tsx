import { ElementRecord, DraftRecord } from '@scrylux/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AcceptEditor } from './AcceptEditor.js';
import { draftItems } from './draft-items.js';
import { DRAFT_API_ID, DRAFT_ASSET_ID, DRAFT_ASSUMPTION_ID, DRAFT_BOUNDARY_ID, DRAFT_DB_ID, DRAFT_FLOW_ID, MODEL_ID, draftRecord, element } from '../test-utils.js';

// The form in which an item is accepted with changes (Phase 3 Milestone 5, US3, FR-013): the model's values filled in, the fields the kind of item
// takes, rationale and citations shown and not editable, and a request that carries only what the person changed.

const draft = DraftRecord.parse(draftRecord({ elements: draftRecord().elements.map((e) => (e.id === DRAFT_API_ID ? { ...e, boundary_id: DRAFT_BOUNDARY_ID } : e)) }));
const existing = [
  ElementRecord.parse(element({ id: '10000000-0000-4000-8000-000000000001', type: 'process', name: 'Worker' })),
  ElementRecord.parse(element({ id: '10000000-0000-4000-8000-000000000002', type: 'trust_boundary', name: 'DMZ' })),
  ElementRecord.parse(element({ id: '10000000-0000-4000-8000-000000000003', type: 'data_flow', name: 'Existing flow' })),
];

function open(id: string, over: { error?: string | null; pending?: boolean } = {}) {
  const item = draftItems(draft).find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error('no such item');
  const onAccept = vi.fn();
  const onCancel = vi.fn();
  render(<AcceptEditor draft={draft} item={item} elements={existing} pending={over.pending ?? false} error={over.error ?? null} onAccept={onAccept} onCancel={onCancel} />);
  return { onAccept, onCancel, form: screen.getByRole('form', { name: 'Accept with changes' }) };
}

describe('an element', () => {
  it('shows the model’s name and boundary, one control for each flag of its type with the proposed value marked, and the rationale as text', () => {
    const { form } = open(DRAFT_API_ID);
    expect(within(form).getByLabelText<HTMLInputElement>('Name').value).toBe('API');
    expect(within(form).getByLabelText<HTMLSelectElement>('Boundary').selectedOptions[0]?.textContent).toBe('Private network (in this draft)');
    const flag = within(form).getByLabelText<HTMLSelectElement>('Internet facing');
    expect(flag.value).toBe('true');
    expect([...flag.options].map((option) => option.textContent)).toEqual(['Not assessed', 'Yes (proposed)', 'No']);
    // A flag of the type that the model did not propose starts as not assessed.
    expect(within(form).getByLabelText<HTMLSelectElement>('Requires authentication').value).toBe('');
    // A flag that does not apply to a process is not offered.
    expect(within(form).queryByLabelText('Encrypted at rest')).toBeNull();
    expect(form.textContent).toContain('The API serves the web application.');
    expect(form.textContent).toContain('The rationale and the citations cannot be edited.');
  });

  it('offers the draft’s boundaries and the threat model’s, and none, as boundaries', () => {
    const { form } = open(DRAFT_API_ID);
    const options = [...within(form).getByLabelText<HTMLSelectElement>('Boundary').options].map((option) => option.textContent);
    expect(options).toEqual(['None', 'Private network (in this draft)', 'DMZ (in the threat model)']);
  });

  it('sends nothing but what changed: a new name, a flag cleared, a flag set, another boundary', async () => {
    const user = userEvent.setup();
    const { form, onAccept } = open(DRAFT_API_ID);
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Gateway');
    await user.selectOptions(within(form).getByLabelText('Internet facing'), '');
    await user.selectOptions(within(form).getByLabelText('Requires authentication'), 'false');
    await user.selectOptions(within(form).getByLabelText('Boundary'), 'element:10000000-0000-4000-8000-000000000002');
    await user.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith({
      name: 'Gateway',
      flags: { internet_facing: null, requires_authentication: false },
      boundary: { element: '10000000-0000-4000-8000-000000000002' },
    });
  });

  it('sends no edits when nothing changed, and nothing at all when cancelled', async () => {
    const user = userEvent.setup();
    const { form, onAccept, onCancel } = open(DRAFT_API_ID);
    await user.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith(undefined);
    onAccept.mockClear();
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });

  it('sends none for a boundary chosen as none, when the model proposed one', async () => {
    const user = userEvent.setup();
    const { form, onAccept } = open(DRAFT_API_ID);
    await user.selectOptions(within(form).getByLabelText('Boundary'), '');
    await user.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith({ boundary: null });
  });

  it('shows what the API refused, beside the form, as text', () => {
    const { form } = open(DRAFT_API_ID, { error: 'An element cannot be its own parent <b>' });
    expect(within(form).getByRole('alert').textContent).toBe('An element cannot be its own parent <b>');
    expect(form.querySelector('b')).toBeNull();
  });
});

describe('a data flow', () => {
  it('offers the nodes of the draft and of the threat model as its ends, and sends a changed end', async () => {
    const user = userEvent.setup();
    const { form, onAccept } = open(DRAFT_FLOW_ID);
    const from = within(form).getByLabelText<HTMLSelectElement>('From');
    expect(from.selectedOptions[0]?.textContent).toBe('API (in this draft)');
    expect([...from.options].map((option) => option.textContent)).toEqual(['API (in this draft)', 'Database (in this draft)', 'Worker (in the threat model)']);
    expect(within(form).queryByLabelText('Boundary')).toBeNull();
    await user.selectOptions(within(form).getByLabelText('To'), 'element:10000000-0000-4000-8000-000000000001');
    await user.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith({ target: { element: '10000000-0000-4000-8000-000000000001' } });
  });
});

describe('an asset and an assumption', () => {
  it('changes an asset’s name, description and holders', async () => {
    const user = userEvent.setup();
    const { form, onAccept } = open(DRAFT_ASSET_ID);
    expect(within(form).getByLabelText<HTMLTextAreaElement>('Description').value).toBe('The threats the application stores.');
    expect(within(form).getByLabelText<HTMLInputElement>('Database (in this draft)').checked).toBe(true);
    await user.clear(within(form).getByLabelText('Description'));
    await user.type(within(form).getByLabelText('Description'), 'Edited.');
    await user.click(within(form).getByLabelText('Database (in this draft)'));
    await user.click(within(form).getByLabelText('Worker (in the threat model)'));
    await user.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith({ description: 'Edited.', holders: [{ element: '10000000-0000-4000-8000-000000000001' }] });
  });

  it('changes an assumption’s statement and nothing else', async () => {
    const user = userEvent.setup();
    const { form, onAccept } = open(DRAFT_ASSUMPTION_ID);
    expect(within(form).queryByLabelText('Name')).toBeNull();
    await user.clear(within(form).getByLabelText('Statement'));
    await user.type(within(form).getByLabelText('Statement'), 'It is.');
    await user.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(onAccept).toHaveBeenCalledWith({ statement: 'It is.' });
  });
});

describe('the draft’s own ids', () => {
  it('uses the draft item’s id for an end that is an item, never an element id', () => {
    const { form } = open(DRAFT_FLOW_ID);
    const values = [...within(form).getByLabelText<HTMLSelectElement>('To').options].map((option) => option.value);
    expect(values).toContain(`item:${DRAFT_DB_ID}`);
    void MODEL_ID;
  });
});
