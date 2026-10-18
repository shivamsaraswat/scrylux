import type { ElementRecord } from '@scrylux/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { DiagramEditorContext, type DiagramEditor } from './DiagramEditorProvider.js';

// Shared by the diagram's component tests: an editor whose actions are spies, so a test asserts what a
// component asks the editor to do without a server. Not a test file, so Vitest does not collect it.

export const MODEL = '33333333-3333-4333-8333-333333333333';
export const eid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function el(n: number, overrides: Partial<ElementRecord> = {}): ElementRecord {
  return {
    id: eid(n),
    threat_model_id: MODEL,
    type: 'process',
    name: `Element ${n}`,
    properties: {},
    layout: { x: 0, y: 0 },
    source_element_id: null,
    target_element_id: null,
    parent_boundary_id: null,
    created_at: '2026-10-07T10:00:00.000Z',
    updated_at: '2026-10-07T10:00:00.000Z',
    ...overrides,
  };
}

export function fakeEditor(overrides: Partial<DiagramEditor> = {}): DiagramEditor {
  return {
    threatModelId: MODEL,
    elements: [],
    isPending: false,
    loadError: null,
    reload: vi.fn(),
    status: 'saved',
    saveError: null,
    pendingCount: 0,
    apply: vi.fn(),
    retry: vi.fn(),
    whenSettled: vi.fn(() => Promise.resolve('saved' as const)),
    openThreats: new Map(),
    selectedIds: [],
    select: vi.fn(),
    focusNameFor: null,
    requestNameFocus: vi.fn(),
    clearNameFocus: vi.fn(),
    notice: null,
    setNotice: vi.fn(),
    deleteRequest: null,
    requestDelete: vi.fn(),
    clearDeleteRequest: vi.fn(),
    undoLabel: null,
    redoLabel: null,
    undo: vi.fn(),
    redo: vi.fn(),
    ...overrides,
  };
}

export function renderWithEditor(ui: ReactElement, editor: DiagramEditor = fakeEditor()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DiagramEditorContext.Provider value={editor}>
        <ReactFlowProvider>{ui}</ReactFlowProvider>
      </DiagramEditorContext.Provider>
    </QueryClientProvider>,
  );
}
