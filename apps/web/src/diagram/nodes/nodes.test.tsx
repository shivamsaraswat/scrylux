import { NODE_SIZE } from '@scrylux/core';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DiagramNodeData } from '../flow.js';
import { el } from '../test-helpers.js';
import { nodeTypes } from './node-types.js';

// FR-004, FR-027: each node type is drawn in its own shape, with its name shown as text.

function renderNode(element: ReturnType<typeof el>, openThreats = 0) {
  const node: Node<DiagramNodeData> = {
    id: element.id,
    type: element.type,
    position: { x: 0, y: 0 },
    data: { label: element.name, element, openThreats },
  };
  return render(
    <ReactFlowProvider>
      <div style={{ width: 600, height: 400 }}>
        <ReactFlow nodes={[node]} edges={[]} nodeTypes={nodeTypes} />
      </div>
    </ReactFlowProvider>,
  );
}

describe('the node types', () => {
  it.each(['external_entity', 'process', 'data_store'] as const)('draws %s in its own shape, at its fixed size', (type) => {
    const { container } = renderNode(el(1, { type, name: 'Thing' }));

    const shape = container.querySelector<HTMLElement>(`.diagram-node--${type}`);
    expect(shape, `a .diagram-node--${type} element`).not.toBeNull();
    expect(shape?.style.width).toBe(`${NODE_SIZE[type].width}px`);
    expect(shape?.style.height).toBe(`${NODE_SIZE[type].height}px`);
    expect(screen.getByText('Thing')).toBeTruthy();
  });

  it('gives a node a connection point on every side, so a flow can leave and arrive anywhere', () => {
    const { container } = renderNode(el(1, { type: 'process' }));
    const sides = [...container.querySelectorAll('.react-flow__handle')].map((handle) => handle.getAttribute('data-handleid')).sort();
    expect(sides).toEqual(['bottom', 'left', 'right', 'top']);
  });

  // The accessible name is on the node itself (flow.ts); the badge repeats it for the eye (spec FR-015, FR-017).
  it('shows the open-threat count as a badge with its text alternative, only when above 0', () => {
    const { container } = renderNode(el(1, { type: 'process', name: 'API' }), 2);
    const badge = container.querySelector('.diagram-badge');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('title')).toBe('2 open threats');
    document.body.innerHTML = '';
    expect(renderNode(el(1, { type: 'process', name: 'API' }), 0).container.querySelector('.diagram-badge')).toBeNull();
  });

  it('says "1 open threat" in the singular', () => {
    const { container } = renderNode(el(1, { type: 'data_store', name: 'DB' }), 1);
    expect(container.querySelector('.diagram-badge')?.getAttribute('title')).toBe('1 open threat');
  });

  it('shows markup in a name literally and renders none of it (FR-027)', () => {
    const { container } = renderNode(el(1, { type: 'process', name: '<img src=x onerror=alert(1)>' }));
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
});
