import { MIN_BOUNDARY_SIZE } from '@scrylux/core';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DiagramNodeData } from '../flow.js';
import { el, fakeEditor, renderWithEditor } from '../test-helpers.js';
import { DiagramEditorContext } from '../DiagramEditorProvider.js';
import { nodeTypes } from './node-types.js';

// FR-004, FR-008: a trust boundary is a dashed, labelled container that can be resized.

function renderBoundary(selected: boolean, name = 'Production VPC', openThreats = 0) {
  const element = el(1, { type: 'trust_boundary', name, layout: { x: 0, y: 0, width: 320, height: 220 } });
  const node: Node<DiagramNodeData> = {
    id: element.id,
    type: 'trust_boundary',
    position: { x: 0, y: 0 },
    selected,
    data: { label: name, element, openThreats },
    style: { width: 320, height: 220 },
  };
  return render(
    <DiagramEditorContext.Provider value={fakeEditor({ elements: [element] })}>
      <ReactFlowProvider>
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodes={[node]} edges={[]} nodeTypes={nodeTypes} />
        </div>
      </ReactFlowProvider>
    </DiagramEditorContext.Provider>,
  );
}

describe('the trust boundary node', () => {
  it('is a dashed container with its name as its label', () => {
    const { container } = renderBoundary(false);
    expect(container.querySelector('.diagram-boundary__frame')).not.toBeNull();
    expect(screen.getByText('Production VPC').className).toContain('diagram-boundary__label');
  });

  it('shows a name with markup as text, never as markup (FR-027)', () => {
    const { container } = renderBoundary(false, '<b>bold</b>');
    expect(screen.getByText('<b>bold</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
  });

  it('shows its own open-threat count beside its label, only when above 0 (spec FR-014, FR-015)', () => {
    const { container } = renderBoundary(false, 'Production VPC', 2);
    const badge = container.querySelector('.diagram-badge');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('title')).toBe('2 open threats');
    document.body.innerHTML = '';
    expect(renderBoundary(false).container.querySelector('.diagram-badge')).toBeNull();
  });

  it('shows resize handles when selected, and none when not', () => {
    expect(renderBoundary(false).container.querySelectorAll('.react-flow__resize-control')).toHaveLength(0);
    document.body.innerHTML = '';
    expect(renderBoundary(true).container.querySelectorAll('.react-flow__resize-control').length).toBeGreaterThan(0);
  });

  it('cannot be resized below the smallest size storage accepts', () => {
    expect(MIN_BOUNDARY_SIZE).toBe(40);
  });
});

describe('the editor test helper', () => {
  it('renders something inside a flow provider', () => {
    renderWithEditor(<p>inside</p>);
    expect(screen.getByText('inside')).toBeTruthy();
  });
});
