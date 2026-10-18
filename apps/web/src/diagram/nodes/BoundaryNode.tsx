import { MIN_BOUNDARY_SIZE } from '@scrylux/core';
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react';
import { useDiagramEditor } from '../DiagramEditorProvider.js';
import { openThreatsText, type DiagramNodeData } from '../flow.js';
import { resizeBoundary } from '../membership.js';

// A trust boundary: a dashed container with its name. It is moved by its label, so the rest of it can be
// clicked through to the elements and the empty space inside, and resized from its handles once selected.
// A resize is saved when it ends, together with whatever it takes in or leaves out (FR-008, FR-009).
export function BoundaryNode({ id, data, selected }: NodeProps<Node<DiagramNodeData>>) {
  const editor = useDiagramEditor();
  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={MIN_BOUNDARY_SIZE}
        minHeight={MIN_BOUNDARY_SIZE}
        onResizeEnd={(_event, rect) => {
          const result = resizeBoundary(editor.elements ?? [], id, rect);
          if (result.kind === 'changes') editor.apply(result.action);
          else if (result.kind === 'refused') editor.setNotice(result.message);
        }}
      />
      <div className="diagram-boundary__frame">
        <span className="diagram-boundary__label">{data.element.name}</span>
        {data.openThreats > 0 && (
          <span className="diagram-badge" title={openThreatsText(data.openThreats)} aria-hidden="true">
            {data.openThreats}
          </span>
        )}
      </div>
    </>
  );
}
