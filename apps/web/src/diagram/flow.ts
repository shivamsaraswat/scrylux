import { TYPE_LABELS, absoluteRects, resolveLayout, type ElementRecord, type Rect, type Resolved } from '@scrylux/core';
import { MarkerType, type Edge, type Node } from '@xyflow/react';

// Turns a threat model's elements into what React Flow draws. Elements keep their positions relative
// to their parent boundary (data-model.md "layout"), which is also React Flow's sub-flow model, so a
// stored position is used as it is. Where an element has none, placement.ts chooses one for the screen.

export interface DiagramNodeData extends Record<string, unknown> {
  label: string;
  element: ElementRecord;
  // How many open threats are linked to the element: the work still to do on it (spec FR-015).
  openThreats: number;
}

export interface FlowEdgeData extends Record<string, unknown> {
  // How far the line bows away from a straight one, in units, signed relative to its own direction.
  curve: number;
  openThreats: number;
}

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

// "3 open threats", the count in words: the badge's tooltip, and the end of an element's accessible name.
export const openThreatsText = (count: number): string => `${count} open ${count === 1 ? 'threat' : 'threats'}`;
const withCount = (name: string, count: number): string => (count > 0 ? `${name}, ${openThreatsText(count)}` : name);

// How many boundaries enclose the element. React Flow needs a parent in the array before its
// children, or it reports "Parent node not found" (research #13).
function depthOf(element: ElementRecord, byId: ReadonlyMap<string, ElementRecord>): number {
  let depth = 0;
  const seen = new Set([element.id]);
  let parentId = element.parent_boundary_id;
  while (parentId !== null && !seen.has(parentId) && byId.has(parentId)) {
    seen.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parent_boundary_id ?? null;
  }
  return depth;
}

// Selection is not set here: React Flow owns it (see Canvas).
export function toFlowNodes(
  elements: readonly ElementRecord[],
  resolved: ReadonlyMap<string, Resolved> = resolveLayout(elements),
  counts: ReadonlyMap<string, number> = NO_COUNTS,
): Node<DiagramNodeData>[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  return elements
    .filter((element) => element.type !== 'data_flow')
    .map((element) => {
      const at = resolved.get(element.id) ?? { x: 0, y: 0 };
      const openThreats = counts.get(element.id) ?? 0;
      const node: Node<DiagramNodeData> = {
        id: element.id,
        type: element.type,
        position: { x: at.x, y: at.y },
        data: { label: element.name, element, openThreats },
        // What a screen reader says for the node: what it is and what it is called, never its id, and how many
        // open threats it has (spec FR-017).
        ariaLabel: withCount(`${TYPE_LABELS[element.type]} ${element.name}`, openThreats),
        // A boundary is moved by its label alone, so that the space inside it stays free for what it holds.
        ...(element.type === 'trust_boundary' ? { dragHandle: '.diagram-boundary__label' } : {}),
        ...(element.parent_boundary_id !== null && byId.get(element.parent_boundary_id)?.type === 'trust_boundary'
          ? { parentId: element.parent_boundary_id }
          : {}),
        ...(at.width !== undefined && at.height !== undefined ? { style: { width: at.width, height: at.height } } : {}),
      };
      return { node, depth: depthOf(element, byId), area: (at.width ?? 0) * (at.height ?? 0) };
    })
    // The order is the order of drawing, and it must not depend on the order the server happened to return:
    // parents before children, boundaries before the nodes beside them, and of boundaries that overlap the
    // larger first, so the one inside is on top and can be reached. Ties fall back to the id.
    .sort(
      (a, b) =>
        a.depth - b.depth ||
        Number(a.node.type !== 'trust_boundary') - Number(b.node.type !== 'trust_boundary') ||
        b.area - a.area ||
        a.node.id.localeCompare(b.node.id),
    )
    .map(({ node }) => node);
}

type Side = 'top' | 'right' | 'bottom' | 'left';
const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const CURVE_SPACING = 40;

// The side of `from` that faces `to`: horizontal when they are further apart across than down.
function facing(from: Rect, to: Rect): Side {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

export function toFlowEdges(
  elements: readonly ElementRecord[],
  resolved: ReadonlyMap<string, Resolved> = resolveLayout(elements),
  counts: ReadonlyMap<string, number> = NO_COUNTS,
): Edge<FlowEdgeData>[] {
  const rects = absoluteRects(elements, resolved);
  const nameOf = new Map(elements.map((element) => [element.id, element.name]));
  const flows = elements.filter(
    (element) =>
      element.type === 'data_flow' &&
      element.source_element_id !== null &&
      element.target_element_id !== null &&
      rects.has(element.source_element_id) &&
      rects.has(element.target_element_id),
  );

  // Flows between the same two nodes, in either direction, are spread to either side of the straight
  // line so none is drawn over another (a two-way exchange is two flows). A lone flow is not bowed.
  const pairKey = (flow: ElementRecord): string => [flow.source_element_id, flow.target_element_id].sort().join('|');
  const groups = new Map<string, ElementRecord[]>();
  for (const flow of flows) groups.set(pairKey(flow), [...(groups.get(pairKey(flow)) ?? []), flow].sort((a, b) => a.id.localeCompare(b.id)));

  return flows.map((flow) => {
    const group = groups.get(pairKey(flow)) ?? [flow];
    const index = group.indexOf(flow);
    const spread = (index - (group.length - 1) / 2) * CURVE_SPACING;
    // The spread is measured from the pair's canonical direction; a flow the other way round has its own
    // left and right swapped, so its sign flips to keep it on the same side of the line.
    const canonical = (flow.source_element_id ?? '') <= (flow.target_element_id ?? '');
    const from = rects.get(flow.source_element_id ?? '');
    const to = rects.get(flow.target_element_id ?? '');
    const side = from && to ? facing(from, to) : 'right';
    const openThreats = counts.get(flow.id) ?? 0;
    return {
      id: flow.id,
      type: 'flow',
      source: flow.source_element_id ?? '',
      target: flow.target_element_id ?? '',
      sourceHandle: side,
      targetHandle: OPPOSITE[side],
      label: flow.name,
      ariaLabel: withCount(
        `${TYPE_LABELS.data_flow} ${flow.name}, from ${nameOf.get(flow.source_element_id ?? '') ?? '?'} to ${nameOf.get(flow.target_element_id ?? '') ?? '?'}`,
        openThreats,
      ),
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { curve: canonical ? spread : -spread, openThreats },
    };
  });
}

// A line from one point to another that bows to one side by `curve` (negative: the other side), with the
// point halfway along it for the label.
export function curvedPath(
  source: { x: number; y: number },
  target: { x: number; y: number },
  curve: number,
): [path: string, labelX: number, labelY: number] {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const controlX = (source.x + target.x) / 2 + (-dy / length) * curve * 2;
  const controlY = (source.y + target.y) / 2 + (dx / length) * curve * 2;
  return [
    `M ${source.x},${source.y} Q ${controlX},${controlY} ${target.x},${target.y}`,
    0.25 * source.x + 0.5 * controlX + 0.25 * target.x,
    0.25 * source.y + 0.5 * controlY + 0.25 * target.y,
  ];
}

// Whether a node already on screen is the node that would replace it: same element, same place, same
// parent, same size. Elements that did not change are the same object from one render to the next.
export function sameNode(current: Node<DiagramNodeData>, next: Node<DiagramNodeData>): boolean {
  return (
    current.data.element === next.data.element &&
    current.position.x === next.position.x &&
    current.position.y === next.position.y &&
    current.parentId === next.parentId &&
    current.style?.width === next.style?.width &&
    current.style?.height === next.style?.height &&
    current.data.openThreats === next.data.openThreats &&
    current.ariaLabel === next.ariaLabel
  );
}

export function sameEdge(current: Edge<FlowEdgeData>, next: Edge<FlowEdgeData>): boolean {
  return (
    current.label === next.label &&
    current.source === next.source &&
    current.target === next.target &&
    current.sourceHandle === next.sourceHandle &&
    current.targetHandle === next.targetHandle &&
    current.data?.curve === next.data?.curve &&
    current.data?.openThreats === next.data?.openThreats &&
    current.ariaLabel === next.ariaLabel
  );
}
