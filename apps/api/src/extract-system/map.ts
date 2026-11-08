import { randomUUID } from 'node:crypto';
import type { DraftAnswer, DraftAnswerCitation } from '@scrylux/core';
import { findQuote } from './checks.js';
import type { LabelledChunk } from './content.js';

// Turning a validated answer into the rows of a draft (Phase 3 Milestone 4, research #3, #4, data-model.md). The model's references
// become the ids of the new items, its labels the ids of the chunks that were sent, and each quote the span it occupies in its chunk:
// a draft never holds a copy of a document's text in a citation, so deleting a source leaves none of it (FR-054).
//
// This runs on an answer that already passed the request's checks (checks.ts), so every label, reference and quote resolves. If one
// does not, that is a bug and not a bad answer: it throws, with fixed text that names no part of the answer, and nothing is stored.

export interface MappedItem {
  id: string;
  position: number;
  kind: 'process' | 'data_store' | 'external_entity' | 'data_flow' | 'trust_boundary' | 'asset' | 'assumption';
  name: string | null;
  body: string | null;
  rationale: string;
  boundaryId: string | null;
  sourceItemId: string | null;
  targetItemId: string | null;
  flags: Record<string, boolean>;
}

export interface MappedHolder {
  assetId: string;
  elementId: string;
}

export interface MappedCitation {
  itemId: string;
  /** Set for a citation of one of the item's flags. */
  flag: string | null;
  position: number;
  chunkId: string;
  quoteStart: number;
  quoteEnd: number;
}

export interface MappedDraft {
  items: MappedItem[];
  holders: MappedHolder[];
  citations: MappedCitation[];
}

export function mapAnswer(answer: DraftAnswer, labelled: readonly LabelledChunk[]): MappedDraft {
  const chunks = new Map(labelled.map((chunk) => [chunk.label, chunk]));

  // Every item gets its id first, because items point at each other before any is stored.
  const ids = new Map<string, string>();
  for (const item of [...answer.elements, ...answer.assets, ...answer.assumptions]) ids.set(item.ref, randomUUID());
  const idOf = (ref: string): string => {
    const id = ids.get(ref);
    if (id === undefined) throw new Error('the answer names a reference that no item has');
    return id;
  };
  const optionalIdOf = (ref: string | null): string | null => (ref === null ? null : idOf(ref));

  const items: MappedItem[] = [];
  const holders: MappedHolder[] = [];
  const citations: MappedCitation[] = [];

  const cite = (itemId: string, flag: string | null, list: readonly DraftAnswerCitation[]): void => {
    list.forEach((citation, position) => {
      const chunk = chunks.get(citation.chunk);
      if (chunk === undefined) throw new Error('the answer cites a label that was not sent');
      const span = findQuote(chunk.text, citation.quote);
      if (span === null) throw new Error('the answer quotes a passage that its chunk does not hold');
      citations.push({ itemId, flag, position, chunkId: chunk.chunkId, quoteStart: span.start, quoteEnd: span.end });
    });
  };

  for (const element of answer.elements) {
    const id = idOf(element.ref);
    items.push({
      id,
      position: items.length,
      kind: element.type,
      name: element.name,
      body: null,
      rationale: element.rationale,
      boundaryId: optionalIdOf(element.boundary),
      sourceItemId: optionalIdOf(element.source),
      targetItemId: optionalIdOf(element.target),
      flags: Object.fromEntries(element.flags.map((flag) => [flag.flag, flag.value])),
    });
    cite(id, null, element.citations);
    for (const flag of element.flags) cite(id, flag.flag, flag.citations);
  }

  for (const asset of answer.assets) {
    const id = idOf(asset.ref);
    items.push({ id, position: items.length, kind: 'asset', name: asset.name, body: asset.description, rationale: asset.rationale, boundaryId: null, sourceItemId: null, targetItemId: null, flags: {} });
    for (const holder of asset.held_by) holders.push({ assetId: id, elementId: idOf(holder) });
    cite(id, null, asset.citations);
  }

  for (const assumption of answer.assumptions) {
    const id = idOf(assumption.ref);
    items.push({ id, position: items.length, kind: 'assumption', name: null, body: assumption.statement, rationale: assumption.rationale, boundaryId: null, sourceItemId: null, targetItemId: null, flags: {} });
    cite(id, null, assumption.citations);
  }

  return { items, holders, citations };
}
