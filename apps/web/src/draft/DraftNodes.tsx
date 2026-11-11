import { NODE_SIZE, type ElementType } from '@scrylux/core';
import type { Node, NodeProps } from '@xyflow/react';
import type { ItemState } from '@scrylux/core';

// The nodes of the draft's diagram (Phase 3 Milestone 4, FR-060): read-only, so they have no handle to connect from and no resizer.
// They use the threat model diagram's own classes, so a draft looks like the diagram it may become. The name is a text child, so
// markup in it is shown and never run (FR-066).

export interface DraftNodeData extends Record<string, unknown> {
  label: string;
  type: ElementType;
  /** Where the item stands in the review: an accepted one is drawn as in the model, a rejected one dimmed (Phase 3 Milestone 5, FR-001). */
  state: ItemState;
}

export function DraftNode({ data }: NodeProps<Node<DraftNodeData>>) {
  const size = NODE_SIZE[data.type as keyof typeof NODE_SIZE];
  return (
    <div className={`diagram-node diagram-node--${data.type} draft-node--${data.state}`} style={{ width: size.width, height: size.height }}>
      <span className="diagram-node__label">{data.label}</span>
    </div>
  );
}

export function DraftBoundaryNode({ data }: NodeProps<Node<DraftNodeData>>) {
  return (
    <div className={`diagram-boundary__frame draft-node--${data.state}`}>
      <span className="diagram-boundary__label">{data.label}</span>
    </div>
  );
}

export const draftNodeTypes = {
  process: DraftNode,
  data_store: DraftNode,
  external_entity: DraftNode,
  trust_boundary: DraftBoundaryNode,
};
