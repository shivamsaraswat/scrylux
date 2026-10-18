import { NODE_SIZE } from '@scrylux/core';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { openThreatsText, type DiagramNodeData } from '../flow.js';

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const;

type NodeType = keyof typeof NODE_SIZE;

// An external entity, a process or a data store: the name in a shape of its own (FR-004), at the fixed size
// for its type. The name is a text child, so markup in it is shown, never run (FR-027). A flow can leave
// from or arrive at any side; the connection mode is loose, so every point accepts either.
export function ElementNode({ data }: NodeProps<Node<DiagramNodeData>>) {
  const { element, openThreats } = data;
  const size = NODE_SIZE[element.type as NodeType];
  return (
    <div className={`diagram-node diagram-node--${element.type}`} style={{ width: size.width, height: size.height }}>
      <span className="diagram-node__label">{element.name}</span>
      {/* The node's own accessible name already ends with the count, so the badge is for the eye only. */}
      {openThreats > 0 && (
        <span className="diagram-badge" title={openThreatsText(openThreats)} aria-hidden="true">
          {openThreats}
        </span>
      )}
      {SIDES.map(([id, position]) => (
        <Handle key={id} id={id} type="source" position={position} />
      ))}
    </div>
  );
}
