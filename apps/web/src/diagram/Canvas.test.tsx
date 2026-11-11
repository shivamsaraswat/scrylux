import type { OnConnect, OnConnectEnd, OnNodeDrag, OnSelectionChangeFunc, ReactFlowProps } from '@xyflow/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVALID_FLOW_MESSAGE } from './connect.js';
import { Canvas } from './Canvas.js';
import { DiagramEditorContext, type DiagramEditor } from './DiagramEditorProvider.js';
import { eid, el, fakeEditor, renderWithEditor } from './test-helpers.js';

// React Flow cannot lay out or drag in jsdom, so its component is replaced by one that hands the test
// the props the canvas gave it. What is tested is what the canvas does when React Flow reports a
// connection, a drag or a selection.
const captured = vi.hoisted(() => ({ props: null as ReactFlowProps | null, remeasure: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const original = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...original,
    useUpdateNodeInternals: () => captured.remeasure,
    ReactFlow: (props: ReactFlowProps) => {
      captured.props = props;
      return <div data-testid="flow" />;
    },
  };
});

const elements = [
  el(1, { type: 'external_entity', layout: { x: 0, y: 0 } }),
  el(2, { type: 'process', layout: { x: 300, y: 0 } }),
  el(3, { type: 'trust_boundary', layout: { x: 0, y: 200, width: 300, height: 200 } }),
];

const props = () => captured.props as ReactFlowProps;
const connection = (source: string | null, target: string | null) =>
  ({ source, target, sourceHandle: null, targetHandle: null }) as Parameters<OnConnect>[0];

beforeEach(() => {
  captured.props = null;
  captured.remeasure.mockClear();
});

describe('the canvas (US1)', () => {
  it('gives React Flow the elements as nodes, with Delete left to the editor', () => {
    renderWithEditor(<Canvas />, fakeEditor({ elements }));
    expect(screen.getByRole('application', { name: 'Data-flow diagram' })).toBeTruthy();
    expect(props().nodes?.map((n) => n.id)).toEqual(expect.arrayContaining([eid(1), eid(2), eid(3)]));
    expect(props().deleteKeyCode).toBeNull();
  });

  it('creates a data flow named "New data flow" when two different nodes are connected', () => {
    const editor = fakeEditor({ elements });
    renderWithEditor(<Canvas />, editor);

    act(() => props().onConnect?.(connection(eid(1), eid(2))));

    expect(editor.apply).toHaveBeenCalledTimes(1);
    const op = vi.mocked(editor.apply).mock.calls[0]?.[0].ops[0];
    expect(op).toMatchObject({
      op: 'create',
      element: { type: 'data_flow', name: 'New data flow', source_element_id: eid(1), target_element_id: eid(2) },
    });
    expect(editor.setNotice).toHaveBeenCalledWith(null);
  });

  it.each([
    ['the same node', eid(2), eid(2)],
    ['a trust boundary', eid(1), eid(3)],
  ])('creates nothing and says why when a connection ends on %s', (_label, source, target) => {
    const editor = fakeEditor({ elements });
    renderWithEditor(<Canvas />, editor);

    act(() => props().onConnect?.(connection(source, target)));

    expect(editor.apply).not.toHaveBeenCalled();
    expect(editor.setNotice).toHaveBeenCalledWith(INVALID_FLOW_MESSAGE);
  });

  it('says the same when a connection is let go on empty space, and only once when it was already refused', () => {
    const editor = fakeEditor({ elements });
    renderWithEditor(<Canvas />, editor);

    act(() => (props().onConnectEnd as OnConnectEnd)(new MouseEvent('mouseup'), { isValid: null, toNode: null, fromNode: null } as never));
    expect(editor.apply).not.toHaveBeenCalled();
    expect(editor.setNotice).toHaveBeenCalledTimes(1);
    expect(editor.setNotice).toHaveBeenLastCalledWith(INVALID_FLOW_MESSAGE);

    vi.mocked(editor.setNotice).mockClear();
    act(() => props().onConnect?.(connection(eid(2), eid(2))));
    act(() => (props().onConnectEnd as OnConnectEnd)(new MouseEvent('mouseup'), { isValid: false, toNode: { id: eid(2) }, fromNode: { id: eid(2) } } as never));
    expect(editor.setNotice).toHaveBeenCalledTimes(1);
  });

  it('saves a drag as one action, one update per node moved, in the node’s own frame', () => {
    const editor = fakeEditor({ elements });
    renderWithEditor(<Canvas />, editor);
    const moved = [
      { id: eid(1), position: { x: 40, y: 50 } },
      { id: eid(2), position: { x: 340, y: 60 } },
    ];

    act(() => (props().onNodeDragStop as OnNodeDrag)(new MouseEvent('mouseup') as never, moved[0] as never, moved as never));

    expect(editor.apply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(editor.apply).mock.calls[0]?.[0].ops).toEqual([
      { op: 'update', id: eid(1), changes: { layout: { x: 40, y: 50 } } },
      { op: 'update', id: eid(2), changes: { layout: { x: 340, y: 60 } } },
    ]);
  });

  it('saves nothing for a click that did not move the node', () => {
    const editor = fakeEditor({ elements });
    renderWithEditor(<Canvas />, editor);
    const same = [{ id: eid(1), position: { x: 0, y: 0 } }];

    act(() => (props().onNodeDragStop as OnNodeDrag)(new MouseEvent('mouseup') as never, same[0] as never, same as never));

    expect(editor.apply).not.toHaveBeenCalled();
  });

  it('reports what is selected to the editor', () => {
    const editor = fakeEditor({ elements });
    renderWithEditor(<Canvas />, editor);

    act(() => (props().onSelectionChange as OnSelectionChangeFunc)({ nodes: [{ id: eid(2) }], edges: [] } as never));

    expect(editor.select).toHaveBeenCalledWith([eid(2)]);
  });

  it('shows the selection the editor holds', () => {
    renderWithEditor(<Canvas />, fakeEditor({ elements, selectedIds: [eid(2)] }));
    const selected = props().nodes?.filter((n) => n.selected).map((n) => n.id);
    expect(selected).toEqual([eid(2)]);
  });
});

// A node that changes (a rename, a confirmed save) is rebuilt, and React Flow forgets the handles of a rebuilt node that carries no
// measurement: a flow can then be neither started from it nor dropped on it, until it is measured again, which React Flow does
// not do by itself. A node added and changed before its first measurement arrived is such a node (seen as a flaky browser test).
describe('a node rebuilt before it was measured', () => {
  const mount = (editor: DiagramEditor) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (current: DiagramEditor) => (
      <QueryClientProvider client={client}>
        <DiagramEditorContext.Provider value={current}>
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
        </DiagramEditorContext.Provider>
      </QueryClientProvider>
    );
    const view = render(tree(editor));
    return (next: DiagramEditor) => view.rerender(tree(next));
  };
  const renamed = [elements[0] as (typeof elements)[number], { ...(elements[1] as (typeof elements)[number]), name: 'Renamed' }, elements[2] as (typeof elements)[number]];

  it('is measured again, and only that node', () => {
    const show = mount(fakeEditor({ elements }));
    expect(captured.remeasure).not.toHaveBeenCalled();
    show(fakeEditor({ elements: renamed }));
    expect(captured.remeasure).toHaveBeenCalledTimes(1);
    expect(captured.remeasure).toHaveBeenCalledWith([eid(2)]);
  });

  it('is not measured again once it has a measurement to carry over', () => {
    const show = mount(fakeEditor({ elements }));
    act(() => (props().onNodesChange as (changes: unknown[]) => void)([{ type: 'dimensions', id: eid(2), dimensions: { width: 140, height: 60 } }]));
    show(fakeEditor({ elements: renamed }));
    expect(captured.remeasure).not.toHaveBeenCalled();
  });
});
