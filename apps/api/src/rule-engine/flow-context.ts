import type { ElementType } from '@scrylux/core';
import { NODE_TYPES, type FlowContext, type NodeType } from '@scrylux/threat-library';

// The columns of a stored element that generation reads.
export interface ElementRow {
  id: string;
  type: ElementType;
  name: string;
  properties: unknown;
  source_element_id: string | null;
  target_element_id: string | null;
  parent_boundary_id: string | null;
}

const isNodeType = (type: ElementType): type is NodeType => (NODE_TYPES as readonly string[]).includes(type);

// What the library needs to know about each data flow beyond its own properties (spec FR-002): whether
// it crosses a trust boundary, and its ends' types and names. Membership is stored in
// `parent_boundary_id`; positions on the canvas play no part. A flow crosses a boundary when its two
// ends are not inside exactly the same set of boundaries, nested ones included (M2 FR-010b).
export function computeFlowContexts(elements: readonly ElementRow[]): Map<string, FlowContext> {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const boundaryCount = elements.filter((element) => element.type === 'trust_boundary').length;
  const enclosing = new Map<string, string>();

  // The ids of every boundary around a node, as one sortable key. The database forbids cycles; a
  // chain longer than the number of boundaries would be a storage bug, so it fails the run instead
  // of looping.
  function boundaryKey(node: ElementRow): string {
    const cached = enclosing.get(node.id);
    if (cached !== undefined) return cached;
    const ids: string[] = [];
    let parent = node.parent_boundary_id;
    while (parent !== null) {
      if (ids.length >= boundaryCount) throw new Error('trust boundaries form a cycle');
      ids.push(parent);
      parent = byId.get(parent)?.parent_boundary_id ?? null;
    }
    const key = ids.sort().join(',');
    enclosing.set(node.id, key);
    return key;
  }

  function endpoint(id: string | null): ElementRow & { type: NodeType } {
    const found = id === null ? undefined : byId.get(id);
    if (found === undefined || !isNodeType(found.type)) throw new Error('a data flow endpoint is missing or is not a node');
    return found as ElementRow & { type: NodeType };
  }

  const contexts = new Map<string, FlowContext>();
  for (const element of elements) {
    if (element.type !== 'data_flow') continue;
    const source = endpoint(element.source_element_id);
    const target = endpoint(element.target_element_id);
    contexts.set(element.id, {
      crosses_trust_boundary: boundaryKey(source) !== boundaryKey(target),
      source_type: source.type,
      target_type: target.type,
      source_name: source.name,
      target_name: target.name,
    });
  }
  return contexts;
}
