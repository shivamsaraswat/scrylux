import type { ElementRecord, ThreatRecord } from '@scrylux/core';

// What deleting an element involves, decided before anything is sent (spec FR-021, FR-022, FR-023).
//   - a data flow, a trust boundary, or a node with no flows: nothing to ask. A boundary's members are kept
//     (they move up to its parent), so it takes nothing with it;
//   - a node with flows: its flows are deleted with it, so the user is asked first, and told how many;
//   - an element, or a flow that would go with it, that has threats linked to it: refused, naming them.
export type DeletePlan =
  | { kind: 'now' }
  | { kind: 'confirm'; flows: number }
  | { kind: 'blocked'; threats: { id: string; title: string; elementName: string }[] };

const NODES = ['external_entity', 'process', 'data_store'];

export function planDelete(elements: readonly ElementRecord[], threats: readonly ThreatRecord[], id: string): DeletePlan {
  const element = elements.find((candidate) => candidate.id === id);
  if (!element) return { kind: 'now' };
  const flows = NODES.includes(element.type)
    ? elements.filter((candidate) => candidate.type === 'data_flow' && (candidate.source_element_id === id || candidate.target_element_id === id))
    : [];
  const going = new Map([element, ...flows].map((candidate) => [candidate.id, candidate.name]));
  const blocking = threats.flatMap((threat) =>
    threat.element_id !== null && going.has(threat.element_id)
      ? [{ id: threat.id, title: threat.title, elementName: going.get(threat.element_id) ?? '' }]
      : [],
  );
  if (blocking.length > 0) return { kind: 'blocked', threats: blocking };
  return flows.length > 0 ? { kind: 'confirm', flows: flows.length } : { kind: 'now' };
}
