import {
  ConnectionMode,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type OnConnect,
  type OnConnectEnd,
  type OnConnectStart,
  type OnNodeDrag,
  type OnNodesChange,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { LoadError } from '../components/LoadError.js';
import { INVALID_FLOW_MESSAGE, connectionProblem, newFlowAction } from './connect.js';
import { useDiagramEditor } from './DiagramEditorProvider.js';
import { useNudgeSaver } from './keyboard.js';
import { moveElements } from './membership.js';
import './diagram.css';
import { sameEdge, sameNode, toFlowEdges, toFlowNodes, type DiagramNodeData, type FlowEdgeData } from './flow.js';
import { edgeTypes, nodeTypes } from './nodes/node-types.js';
import { resolveLayout } from '@scrylux/core';

// How the view is fitted, on opening and by the Fit to view button: never zoomed in past 1:1, or the first
// element added would fill the screen and the next ones would land out of sight.
export const FIT_VIEW = { padding: 0.2, maxZoom: 1 } as const;

// What React Flow says about itself to a screen reader, in this editor's words. Each element and flow is
// named by what it is and what it is called, which is set on the node or edge itself.
const ARIA_LABELS = {
  'node.a11yDescription.default': 'Press Enter or Space to select this element. Once selected, the arrow keys move it. Escape lets go.',
  'node.a11yDescription.keyboardDisabled': 'Press Enter or Space to select this element. Once selected, the arrow keys move it. Escape lets go.',
  'edge.a11yDescription.default': 'Press Enter or Space to select this data flow. Escape lets go.',
} as const;

// The diagram of one threat model. React Flow's own attribution link stays: removing it is for
// subscribers. Delete is not left to React Flow: deleting an element has to confirm its cascade and
// check its linked threats first (FR-021, FR-023), so the key is off here and the editor owns it.
export function Canvas() {
  const editor = useDiagramEditor();
  const { elements, isPending, loadError, reload, apply, select, setNotice, requestNameFocus, requestDelete, selectedIds, openThreats } = editor;

  const resolved = useMemo(() => (elements ? resolveLayout(elements) : null), [elements]);
  // A count that changes reaches only the nodes and flows it belongs to: the rest stay the very same objects (sameNode).
  const flowNodes = useMemo(() => (elements && resolved ? toFlowNodes(elements, resolved, openThreats) : []), [elements, resolved, openThreats]);
  const flowEdges = useMemo(() => (elements && resolved ? toFlowEdges(elements, resolved, openThreats) : []), [elements, resolved, openThreats]);

  // SELECTION has one owner: React Flow. It reports a click or a box-select as changes, which are applied
  // here, and the editor is told what ended up selected. Feeding the editor's selection back into the
  // nodes on every change makes the two disagree and trade places forever, so the editor's selection
  // reaches React Flow only when the editor itself chooses something (a new element), and only once.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<DiagramNodeData>>(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<FlowEdgeData>>(flowEdges);
  const wanted = useRef<ReadonlySet<string>>(new Set(selectedIds));
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // When the elements change, the nodes are rebuilt from them. A node whose element has not changed is the
  // very same node as before: replacing it would make React Flow measure it again, and until it has, it is
  // hidden and cannot be clicked, so every confirmed save would make the whole diagram flicker. A node that
  // did change keeps its measurements unless its size did. It also keeps its selection, and a drag that is
  // still going keeps the pointer's position. A node that is new takes the editor's selection, which is how
  // an element just added ends up selected.
  useEffect(() => {
    setNodes((previous) => {
      const before = new Map(previous.map((node) => [node.id, node]));
      return flowNodes.map((node) => {
        const current = before.get(node.id);
        if (!current) return { ...node, selected: wanted.current.has(node.id) };
        if (current.dragging) return { ...node, selected: current.selected === true, position: current.position, dragging: true };
        if (sameNode(current, node)) return current;
        const sameSize = current.style?.width === node.style?.width && current.style?.height === node.style?.height;
        return { ...node, selected: current.selected === true, ...(sameSize && current.measured ? { measured: current.measured } : {}) };
      });
    });
    setEdges((previous) => {
      const before = new Map(previous.map((edge) => [edge.id, edge]));
      return flowEdges.map((edge) => {
        const current = before.get(edge.id);
        if (!current) return { ...edge, selected: wanted.current.has(edge.id) };
        return sameEdge(current, edge) ? current : { ...edge, selected: current.selected === true };
      });
    });
  }, [flowNodes, flowEdges, setNodes, setEdges]);

  // When the editor chooses a selection, React Flow is made to match it. Changing nothing returns the same
  // array, so a selection that already matches causes no render and no further event.
  useEffect(() => {
    wanted.current = new Set(selectedIds);
    const match = <T extends { id: string; selected?: boolean }>(items: T[]): T[] =>
      items.every((item) => (item.selected === true) === wanted.current.has(item.id))
        ? items
        : items.map((item) => ((item.selected === true) === wanted.current.has(item.id) ? item : { ...item, selected: wanted.current.has(item.id) }));
    setNodes(match);
    setEdges(match);
  }, [selectedIds, setNodes, setEdges]);

  // A connection that ended without onConnect having run was let go on empty space.
  const connected = useRef(false);
  const onConnectStart: OnConnectStart = useCallback(() => {
    connected.current = false;
  }, []);
  const onConnect: OnConnect = useCallback(
    (connection) => {
      connected.current = true;
      const problem = connectionProblem(connection.source, connection.target, elements ?? []);
      if (problem) {
        setNotice(problem);
        return;
      }
      setNotice(null);
      const action = newFlowAction(connection.source, connection.target);
      apply(action);
      const created = action.ops[0];
      if (created?.op === 'create') {
        select([created.element.id]);
        requestNameFocus(created.element.id);
      }
    },
    [elements, apply, select, setNotice, requestNameFocus],
  );
  const onConnectEnd: OnConnectEnd = useCallback(() => {
    if (!connected.current) setNotice(INVALID_FLOW_MESSAGE);
    connected.current = false;
  }, [setNotice]);

  // One drag is one action: the elements that moved, and every element whose boundary changes because of
  // it. A boundary dropped into itself is refused and snaps back to where it was.
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, _node, dragged) => {
      if (!elements) return;
      const result = moveElements(
        elements,
        dragged.map((node) => ({ id: node.id, position: node.position })),
      );
      if (result.kind === 'changes') {
        setNotice(null);
        apply(result.action);
      } else if (result.kind === 'refused') {
        setNotice(result.message);
        setNodes((previous) => previous.map((node) => flowNodes.find((original) => original.id === node.id) ?? node));
      }
    },
    [elements, flowNodes, apply, setNotice, setNodes],
  );

  // An element moved with the arrow keys is saved once the keys stop, as one move, and goes into or out of a
  // boundary the same way a dropped one does.
  const nudge = useNudgeSaver(
    useCallback(
      (ids: string[]) => {
        if (!elements) return;
        const result = moveElements(
          elements,
          ids.flatMap((id) => {
            const node = nodesRef.current.find((candidate) => candidate.id === id);
            return node ? [{ id, position: node.position }] : [];
          }),
        );
        if (result.kind === 'changes') {
          setNotice(null);
          apply(result.action);
        } else if (result.kind === 'refused') setNotice(result.message);
      },
      [elements, apply, setNotice],
    ),
  );
  const onNodesChangeObserved: OnNodesChange<Node<DiagramNodeData>> = useCallback(
    (changes) => {
      onNodesChange(changes);
      nudge.observe(changes);
    },
    [onNodesChange, nudge],
  );

  // Escape lets go of the selection.
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') select([]);
      // Delete is the editor's, not React Flow's: it asks about flows and threats first (FR-021, FR-023).
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length === 1 && selectedIds[0]) {
        event.preventDefault();
        requestDelete(selectedIds[0]);
      }
    },
    [select, selectedIds, requestDelete],
  );

  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }) => select([...selectedNodes.map((n) => n.id), ...selectedEdges.map((e) => e.id)]),
    [select],
  );

  if (isPending) return <p>Loading…</p>;
  if (!elements) return <LoadError error={loadError} onRetry={reload} />;

  return (
    <div className="diagram-canvas" role="application" aria-label="Data-flow diagram" onKeyDown={onKeyDown}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChangeObserved}
        onNodeDragStart={nudge.dragStarted}
        onEdgesChange={onEdgesChange}
        onConnectStart={onConnectStart}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDragStop={(event, node, dragged) => {
          nudge.dragStopped();
          onNodeDragStop(event, node, dragged);
        }}
        ariaLabelConfig={ARIA_LABELS}
        onSelectionChange={onSelectionChange}
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT_VIEW}
      />
    </div>
  );
}
