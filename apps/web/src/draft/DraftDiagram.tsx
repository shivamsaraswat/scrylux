import { layoutDraft, type DraftElementRecord, type ItemReview } from '@scrylux/core';
import { MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import '../diagram/diagram.css';
import { draftNodeTypes, type DraftNodeData } from './DraftNodes.js';
import './draft.css';

// The draft as a diagram (Phase 3 Milestone 4, FR-060, FR-061, research #14): boundaries around their members and flows between their
// endpoints, laid out by Scrylux, because the model proposes no positions. It is read-only: nothing can be dragged, connected or
// deleted, and selecting an item shows why it was proposed. React Flow's own attribution link stays.

/** What an accepted or a rejected item says in its label, so that the state is not only a colour. */
const suffix = (item: ItemReview | undefined): string => (item === undefined || item.state === 'undecided' ? '' : ` (${item.state})`);

export function DraftDiagram({
  elements,
  review,
  selectedId,
  onSelect,
  onToggle,
}: {
  elements: readonly DraftElementRecord[];
  review: Record<string, ItemReview>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Shift-click chooses an item for a decision, or takes it back (Phase 3 Milestone 5). */
  onToggle: (id: string) => void;
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
        data: { label: element.name, type: element.type, state: review[element.id]?.state ?? 'undecided' },
        style: { width: node.width, height: node.height },
        ariaLabel: `${element.type.replace(/_/g, ' ')}: ${element.name}${suffix(review[element.id])}`,
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
        ariaLabel: `data flow: ${element.name}${suffix(review[element.id])}`,
        className: `draft-edge--${review[element.id]?.state ?? 'undecided'}`,
        selectable: true,
        focusable: true,
      };
    });
    return { nodes: placed, edges: flows };
  }, [elements, review]);

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
        onNodeClick={(event, node) => (event.shiftKey ? onToggle(node.id) : onSelect(node.id))}
        onEdgeClick={(event, edge) => (event.shiftKey ? onToggle(edge.id) : onSelect(edge.id))}
        onPaneClick={() => onSelect(null)}
      />
    </div>
  );
}
