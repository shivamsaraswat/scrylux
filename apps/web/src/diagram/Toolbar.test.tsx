import { MAX_ELEMENTS } from '@scrylux/core';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Toolbar } from './Toolbar.js';
import { el, fakeEditor, renderWithEditor } from './test-helpers.js';

// FR-002, FR-001a, contracts/ui.md "Canvas".

describe('the Add buttons for nodes', () => {
  it.each([
    ['Add external entity', 'external_entity', 'New external entity'],
    ['Add process', 'process', 'New process'],
    ['Add data store', 'data_store', 'New data store'],
  ])('%s creates a %s named "%s", selects it and asks for its name to be focused', async (button, type, name) => {
    const editor = fakeEditor();
    const user = userEvent.setup();
    renderWithEditor(<Toolbar />, editor);

    await user.click(screen.getByRole('button', { name: button }));

    expect(editor.apply).toHaveBeenCalledTimes(1);
    const action = vi.mocked(editor.apply).mock.calls[0]?.[0];
    expect(action?.ops).toHaveLength(1);
    const op = action?.ops[0];
    expect(op).toMatchObject({ op: 'create', element: { type, name } });
    const created = op?.op === 'create' ? op.element : null;
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isFinite((created?.layout as { x: number } | null | undefined)?.x)).toBe(true);
    expect(Number.isFinite((created?.layout as { y: number } | null | undefined)?.y)).toBe(true);
    expect(editor.select).toHaveBeenCalledWith([created?.id]);
    expect(editor.requestNameFocus).toHaveBeenCalledWith(created?.id);
  });

  it('Add trust boundary creates a boundary named "New trust boundary", 320 by 220, and selects it', async () => {
    const editor = fakeEditor();
    const user = userEvent.setup();
    renderWithEditor(<Toolbar />, editor);

    await user.click(screen.getByRole('button', { name: 'Add trust boundary' }));

    const op = vi.mocked(editor.apply).mock.calls[0]?.[0].ops[0];
    expect(op).toMatchObject({ op: 'create', element: { type: 'trust_boundary', name: 'New trust boundary' } });
    const layout = op?.op === 'create' ? (op.element.layout as Record<string, number>) : {};
    expect(layout.width).toBe(320);
    expect(layout.height).toBe(220);
    const id = op?.op === 'create' ? op.element.id : '';
    expect(editor.select).toHaveBeenCalledWith([id]);
    expect(editor.requestNameFocus).toHaveBeenCalledWith(id);
  });

  it('puts a new element where no other one is', async () => {
    const editor = fakeEditor({ elements: [el(1, { layout: { x: 0, y: 0 } })] });
    const user = userEvent.setup();
    renderWithEditor(<Toolbar />, editor);

    await user.click(screen.getByRole('button', { name: 'Add process' }));

    const op = vi.mocked(editor.apply).mock.calls[0]?.[0].ops[0];
    const layout = op?.op === 'create' ? (op.element.layout as { x: number; y: number }) : null;
    expect(layout).not.toEqual({ x: 0, y: 0 });
  });
});

describe('the element limit (FR-001a)', () => {
  it('disables every Add button at 1,000 elements, and says why', () => {
    const elements = Array.from({ length: MAX_ELEMENTS }, (_, i) => el(i + 1, { layout: { x: i, y: 0 } }));
    renderWithEditor(<Toolbar />, fakeEditor({ elements }));

    for (const name of ['Add external entity', 'Add process', 'Add data store', 'Add trust boundary']) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name });
      expect(button.disabled, name).toBe(true);
      expect(button.getAttribute('aria-describedby')).toBeTruthy();
    }
    expect(screen.getByText('This threat model has reached the limit of 1,000 elements.')).toBeTruthy();
  });

  it('leaves them enabled below the limit', () => {
    renderWithEditor(<Toolbar />, fakeEditor({ elements: [el(1)] }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add process' }).disabled).toBe(false);
    expect(screen.queryByText(/reached the limit/)).toBeNull();
  });
});

describe('the toolbar itself', () => {
  it('is a toolbar named "Diagram tools"', () => {
    renderWithEditor(<Toolbar />);
    expect(screen.getByRole('toolbar', { name: 'Diagram tools' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Fit to view' })).toBeTruthy();
  });

  it('shows a notice from the editor as an alert near the tools', () => {
    renderWithEditor(<Toolbar />, fakeEditor({ notice: 'A data flow must connect two different external entities, processes or data stores.' }));
    expect(screen.getByRole('alert').textContent).toContain('A data flow must connect');
  });
});
