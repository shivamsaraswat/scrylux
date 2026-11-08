import { layoutDraft, type DraftElementRecord } from '@scrylux/core';
import { MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import '../diagram/diagram.css';
import { draftNodeTypes, type DraftNodeData } from './DraftNodes.js';
import './draft.css';

// The draft as a diagram (Phase 3 Milestone 4, FR-060, FR-061, research #14): boundaries around their members and flows between their
// endpoints, laid out by Scrylux, because the model proposes no positions. It is read-only: nothing can be dragged, connected or
// deleted, and selecting an item shows why it was proposed. React Flow's own attribution link stays.

export function DraftDiagram({
  elements,
  selectedId,
  onSelect,
}: {
  elements: readonly DraftElementRecord[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const layout = layoutDraft(elements);
    const byId = new Map(elements.map((element) => [element.id, element]));
    const placed: Node<DraftNodeData>[] = layout.nodes.map((node) => {
      const element = byId.get(node.id) as DraftElementRecord;
      return {
        id: node.id,
        type: element.type,
        position: { x: node.x, y: node.y },
        ...(node.parentId === null ? {} : { parentId: node.parentId, extent: 'parent' as const }),
        data: { label: element.name, type: element.type },
        style: { width: node.width, height: node.height },
        ariaLabel: `${element.type.replace(/_/g, ' ')}: ${element.name}`,
        draggable: false,
        connectable: false,
        selectable: true,
        focusable: true,
      };
    });
    const flows: Edge[] = layout.edges.map((edge) => {
      const element = byId.get(edge.id) as DraftElementRecord;
      return {
        ...edge,
        label: element.name,
        markerEnd: { type: MarkerType.ArrowClosed },
        ariaLabel: `data flow: ${element.name}`,
        selectable: true,
        focusable: true,
      };
    });
    return { nodes: placed, edges: flows };
  }, [elements]);

  const shownNodes = useMemo(() => nodes.map((node) => ({ ...node, selected: node.id === selectedId })), [nodes, selectedId]);
  const shownEdges = useMemo(() => edges.map((edge) => ({ ...edge, selected: edge.id === selectedId })), [edges, selectedId]);

  return (
    <div className="draft-diagram" role="region" aria-label="Draft diagram">
      <ReactFlow
        nodes={shownNodes}
        edges={shownEdges}
        nodeTypes={draftNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        onNodeClick={(_event, node) => onSelect(node.id)}
        onEdgeClick={(_event, edge) => onSelect(edge.id)}
        onPaneClick={() => onSelect(null)}
      />
    </div>
  );
}
