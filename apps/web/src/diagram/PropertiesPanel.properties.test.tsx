import type { JsonValue } from '@scrylux/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DiagramEditor } from './DiagramEditorProvider.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { eid, el, fakeEditor, renderWithEditor } from './test-helpers.js';

// FR-013, FR-015, FR-015a, FR-016, FR-018, spec edge case "stored properties outside the vocabulary".

function open(element: ReturnType<typeof el>, extra: Parameters<typeof fakeEditor>[0] = {}) {
  const editor = fakeEditor({ elements: [element], selectedIds: [element.id], ...extra });
  renderWithEditor(<PropertiesPanel />, editor);
  return editor;
}
const lastOps = (editor: DiagramEditor) => vi.mocked(editor.apply).mock.calls.at(-1)?.[0].ops;
const groups = () => screen.queryAllByRole('radiogroup').map((group) => group.getAttribute('aria-label') ?? group.textContent);
const radio = (group: string, option: 'Yes' | 'No' | 'Not assessed') =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole<HTMLInputElement>('radio', { name: option });

describe('the flags an element can have (FR-015)', () => {
  it.each([
    ['external_entity', ['Authenticated', 'Internet facing']],
    ['process', ['Internet facing', 'Requires authentication', 'Handles sensitive data', 'Runs privileged']],
    ['data_store', ['Stores sensitive data', 'Encrypted at rest', 'Internet facing']],
    ['data_flow', ['Encrypted in transit', 'Authenticated', 'Carries sensitive data']],
    ['trust_boundary', []],
  ] as const)('%s offers exactly its own flags', (type, labels) => {
    open(el(1, { type, layout: type === 'data_flow' ? null : { x: 0, y: 0 } }));
    expect(groups()).toEqual(labels);
  });

  it('shows every flag of a new element as Not assessed, with the three choices', () => {
    open(el(1, { type: 'data_store' }));
    for (const label of ['Stores sensitive data', 'Encrypted at rest', 'Internet facing']) {
      expect(radio(label, 'Not assessed').checked, label).toBe(true);
      expect(radio(label, 'Yes').checked).toBe(false);
      expect(radio(label, 'No').checked).toBe(false);
    }
  });

  it('shows what is stored: true as Yes, false as No, absent as Not assessed', () => {
    open(el(1, { type: 'data_store', properties: { flags: { stores_sensitive_data: true, encrypted_at_rest: false } } }));
    expect(radio('Stores sensitive data', 'Yes').checked).toBe(true);
    expect(radio('Encrypted at rest', 'No').checked).toBe(true);
    expect(radio('Internet facing', 'Not assessed').checked).toBe(true);
  });
});

describe('changing a flag (FR-015a)', () => {
  it('stores Yes as true and No as false', async () => {
    const editor = open(el(1, { type: 'data_store' }));
    const user = userEvent.setup();

    await user.click(radio('Stores sensitive data', 'Yes'));
    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { properties: { flags: { stores_sensitive_data: true } } } }]);

    await user.click(radio('Encrypted at rest', 'No'));
    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { properties: { flags: { encrypted_at_rest: false } } } }]);
  });

  it('removes the flag for Not assessed, so No and not assessed stay different', async () => {
    const editor = open(el(1, { type: 'data_store', properties: { flags: { encrypted_at_rest: false, stores_sensitive_data: true } } }));
    const user = userEvent.setup();

    await user.click(radio('Encrypted at rest', 'Not assessed'));

    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { properties: { flags: { stores_sensitive_data: true } } } }]);
  });

  it('keeps the tags, and drops the flags key when the last flag is cleared', async () => {
    const editor = open(el(1, { type: 'process', properties: { tags: ['nginx'], flags: { runs_privileged: true } } }));
    const user = userEvent.setup();

    await user.click(radio('Runs privileged', 'Not assessed'));

    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { properties: { tags: ['nginx'] } } }]);
  });
});

describe('technology tags (FR-016)', () => {
  it('adds a tag, trimmed, and keeps the flags', async () => {
    const editor = open(el(1, { properties: { flags: { runs_privileged: true } } }));
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Add a technology tag'), '  PostgreSQL 16  ');
    await user.click(screen.getByRole('button', { name: 'Add tag' }));

    expect(lastOps(editor)).toEqual([
      { op: 'update', id: eid(1), changes: { properties: { flags: { runs_privileged: true }, tags: ['PostgreSQL 16'] } } },
    ]);
  });

  it('adds a tag with Enter in the field, and empties the field', async () => {
    const editor = open(el(1));
    const user = userEvent.setup();
    const field = screen.getByLabelText<HTMLInputElement>('Add a technology tag');

    await user.type(field, 'nginx{Enter}');

    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { properties: { tags: ['nginx'] } } }]);
    expect(field.value).toBe('');
  });

  it('lists the tags and removes one', async () => {
    const editor = open(el(1, { properties: { tags: ['nginx', 'Express 5'] } }));
    const user = userEvent.setup();
    expect(screen.getByText('nginx')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove tag nginx' }));

    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { properties: { tags: ['Express 5'] } } }]);
  });

  it('drops the tags key when the last tag is removed', async () => {
    const editor = open(el(1, { properties: { tags: ['nginx'] } }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove tag nginx' }));
    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { properties: {} } }]);
  });

  it.each([
    ['an empty tag', '   ', 'a tag must not be empty'],
    ['a tag over 50 characters', 'x'.repeat(51), 'a tag must be at most 50 characters'],
    ['a tag that is already there, in other letters', 'NGINX', 'tags must be different from each other, ignoring case'],
  ])('refuses %s, with the reason next to the field', async (_label, text, message) => {
    const editor = open(el(1, { properties: { tags: ['nginx'] } }));
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByLabelText('Add a technology tag'), text);
    await user.click(screen.getByRole('button', { name: 'Add tag' }));

    expect(editor.apply).not.toHaveBeenCalled();
    expect(screen.getByText(message)).toBeTruthy();
  });

  it('refuses a 21st tag', async () => {
    const tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    const editor = open(el(1, { properties: { tags } }));
    const user = userEvent.setup({ delay: null });

    await user.type(screen.getByLabelText('Add a technology tag'), 'one more');
    await user.click(screen.getByRole('button', { name: 'Add tag' }));

    expect(editor.apply).not.toHaveBeenCalled();
    expect(screen.getByText('at most 20 tags')).toBeTruthy();
  });

  it('is offered for a trust boundary and a data flow as well', () => {
    open(el(1, { type: 'trust_boundary', layout: { x: 0, y: 0, width: 300, height: 200 } }));
    expect(screen.getByLabelText('Add a technology tag')).toBeTruthy();
  });

  it('shows a tag with markup as text (FR-027)', () => {
    const { container } = renderWithEditor(<PropertiesPanel />, fakeEditor({ elements: [el(1, { properties: { tags: ['<img src=x onerror=alert(1)>'] } })], selectedIds: [eid(1)] }));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('changing the type of a node (FR-006, FR-018)', () => {
  const process = (properties: Record<string, JsonValue>) => el(1, { type: 'process', properties });

  it('asks first when yes or no flags would be removed, naming them, and changes nothing until confirmed', async () => {
    const editor = open(process({ tags: ['nginx'], flags: { runs_privileged: true, internet_facing: false, handles_sensitive_data: true } }));
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Type'), 'data_store');

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Runs privileged');
    expect(dialog.textContent).toContain('Handles sensitive data');
    // internet_facing applies to a data store, so it stays and is not mentioned.
    expect(dialog.textContent).not.toContain('Internet facing');
    expect(editor.apply).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Change type' }));

    expect(lastOps(editor)).toEqual([
      { op: 'update', id: eid(1), changes: { type: 'data_store', properties: { tags: ['nginx'], flags: { internet_facing: false } } } },
    ]);
  });

  it('changes nothing when the question is answered with Cancel', async () => {
    const editor = open(process({ flags: { runs_privileged: true } }));
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Type'), 'data_store');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(editor.apply).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLSelectElement>('Type').value).toBe('process');
  });

  it('changes at once, with no question, when nothing but not assessed flags would be lost', async () => {
    const editor = open(process({ tags: ['nginx'], flags: { internet_facing: true } }));
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Type'), 'data_store');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lastOps(editor)).toEqual([
      { op: 'update', id: eid(1), changes: { type: 'data_store', properties: { tags: ['nginx'], flags: { internet_facing: true } } } },
    ]);
  });

  it('sends only the type when there are no properties to carry', async () => {
    const editor = open(process({}));
    await userEvent.setup().selectOptions(screen.getByLabelText('Type'), 'external_entity');
    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { type: 'external_entity' } }]);
  });
});

describe('properties outside the vocabulary, written before it existed', () => {
  const legacy = () => el(1, { type: 'process', properties: { color: 'red', flags: { runs_privileged: true, shiny: true } } });

  it('lists them read-only, with a note that the next change removes them', () => {
    open(legacy());
    const section = screen.getByRole('region', { name: 'Other stored properties' });
    expect(section.textContent).toContain('color');
    expect(section.textContent).toContain('shiny');
    expect(section.textContent).toMatch(/removed/i);
  });

  it('is not shown for an element without any', () => {
    open(el(1, { properties: { tags: ['nginx'] } }));
    expect(screen.queryByRole('region', { name: 'Other stored properties' })).toBeNull();
  });

  it('asks before the first properties change, and then saves the properties without them', async () => {
    const editor = open(legacy());
    const user = userEvent.setup();

    await user.click(radio('Handles sensitive data', 'Yes'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('color');
    expect(editor.apply).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Remove and save' }));

    expect(lastOps(editor)).toEqual([
      { op: 'update', id: eid(1), changes: { properties: { flags: { runs_privileged: true, handles_sensitive_data: true } } } },
    ]);
  });

  it('keeps everything as it was when the question is answered with Cancel', async () => {
    const editor = open(legacy());
    const user = userEvent.setup();
    await user.click(radio('Handles sensitive data', 'Yes'));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(editor.apply).not.toHaveBeenCalled();
  });

  it('does not ask for a rename, which does not touch the properties', async () => {
    const editor = open(legacy());
    const user = userEvent.setup();
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Renamed{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lastOps(editor)).toEqual([{ op: 'update', id: eid(1), changes: { name: 'Renamed' } }]);
  });
});
