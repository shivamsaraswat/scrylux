import { ELEMENT_FLAGS } from '@scrylux/core';
import { shippedLibrary } from '@scrylux/threat-library';
import { apiRequest, seedModel } from './fixtures.js';

// The load Milestone 3 allows (1,000 elements, about 15,000 threats and 49,000 mitigations), shared by the specs that
// prove a screen or a download stays quick at that size.

export type NodeType = 'external_entity' | 'process' | 'data_store';

// The node type and flag set that give one element the most candidates, found in the shipped library, so the test
// cannot pass at a fraction of the load it claims (as Milestone 3's performance test does).
export function busiest(): { type: NodeType; flags: Record<string, boolean>; candidates: number } {
  const library = shippedLibrary();
  let best = { type: 'process' as NodeType, flags: {} as Record<string, boolean>, candidates: 0 };
  for (const type of ['external_entity', 'process', 'data_store'] as const) {
    const names = ELEMENT_FLAGS[type];
    for (let mask = 0; mask < 1 << names.length; mask++) {
      const flags = Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map((name) => [name, true]));
      const candidates = library.candidatesFor({ type, name: 'E', properties: { flags } }).length;
      if (candidates > best.candidates) best = { type, flags, candidates };
    }
  }
  return best;
}

// Creates `count` elements of one type through the batch endpoint (at most 200 a request), then generates threats.
export async function seed(base: string, token: string, label: string, count: number, type: NodeType, flags: Record<string, boolean>) {
  const { modelId } = await seedModel(base, token, label);
  for (let from = 0; from < count; from += 200) {
    const operations = Array.from({ length: Math.min(200, count - from) }, (_, i) => ({
      op: 'create',
      element: { type, name: `Unit ${from + i}`, properties: { flags } },
    }));
    const res = await apiRequest(base, token, 'POST', `/api/v1/threat-models/${modelId}/elements/batch`, { operations });
    if (res.status !== 200) throw new Error(`Seeding elements failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const run = await apiRequest(base, token, 'POST', `/api/v1/threat-models/${modelId}/threats/generate`, {});
  if (run.status !== 200) throw new Error(`Generating failed: ${run.status} ${JSON.stringify(run.body)}`);
  return { modelId, created: (run.body as { created: number }).created };
}
