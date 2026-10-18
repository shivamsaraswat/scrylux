import type { ElementRecord, ElementType } from '@scrylux/core';
import { newElementId, type DiagramAction } from './operations.js';

// What a data flow may join (spec FR-003): two different external entities, processes or data stores.
// A trust boundary, another flow and empty space are not ends of a flow, and a node cannot flow to
// itself. Storage enforces the same rules; this tells the user before anything is sent.

export const INVALID_FLOW_MESSAGE = 'A data flow must connect two different external entities, processes or data stores.';

const NODE_TYPES: readonly ElementType[] = ['external_entity', 'process', 'data_store'];

export function connectionProblem(
  sourceId: string | null,
  targetId: string | null,
  elements: readonly ElementRecord[],
): string | null {
  if (sourceId === null || targetId === null || sourceId === targetId) return INVALID_FLOW_MESSAGE;
  const source = elements.find((element) => element.id === sourceId);
  const target = elements.find((element) => element.id === targetId);
  if (!source || !target || !NODE_TYPES.includes(source.type) || !NODE_TYPES.includes(target.type)) return INVALID_FLOW_MESSAGE;
  return null;
}

export function newFlowAction(sourceId: string, targetId: string): DiagramAction {
  return {
    label: 'Add data flow',
    ops: [
      {
        op: 'create',
        element: {
          id: newElementId(),
          type: 'data_flow',
          name: 'New data flow',
          source_element_id: sourceId,
          target_element_id: targetId,
        },
      },
    ],
  };
}
