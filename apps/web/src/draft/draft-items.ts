import { TYPE_LABELS, type CitationRecord, type DraftRecord } from '@scrylux/core';

// A draft's items as the page lists and shows them (Phase 3 Milestone 4, FR-060, FR-062): one shape for an element, an asset and an
// assumption, so that the diagram, the list and the panel share a selection. Everything here is text taken from the draft; the
// components render it as text and never as markup (FR-066).

export const GROUP_ORDER = ['process', 'data_store', 'external_entity', 'data_flow', 'trust_boundary', 'asset', 'assumption'] as const;
export type DraftItemGroup = (typeof GROUP_ORDER)[number];

export const GROUP_HEADING: Record<DraftItemGroup, string> = {
  process: 'Processes',
  data_store: 'Data stores',
  external_entity: 'External entities',
  data_flow: 'Data flows',
  trust_boundary: 'Trust boundaries',
  asset: 'Assets',
  assumption: 'Assumptions',
};

export interface DraftItemFlag {
  flag: string;
  value: boolean;
  citations: CitationRecord[];
}

export interface DraftItem {
  id: string;
  group: DraftItemGroup;
  /** What kind of item it is, in words: Process, Data flow, Asset… */
  typeLabel: string;
  /** An element's or an asset's name, or an assumption's statement. */
  title: string;
  rationale: string;
  citations: CitationRecord[];
  flags: DraftItemFlag[];
  /** Short lines about where it sits and what it joins: "In Private network", "From API to Database". */
  facts: string[];
}

/** A citation that still points at a chunk. One whose source was deleted is shown as such and does not count (FR-054). */
export const remaining = (citations: readonly CitationRecord[]): CitationRecord[] => citations.filter((citation) => citation.chunk !== null);

/** Every item of a draft, grouped in the order of GROUP_ORDER and in the order of the answer within a group. */
export function draftItems(draft: DraftRecord): DraftItem[] {
  const names = new Map<string, string>(draft.elements.map((element) => [element.id, element.name]));
  const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));

  const items: DraftItem[] = [];
  for (const element of draft.elements) {
    const facts: string[] = [];
    if (element.type === 'data_flow') {
      const from = nameOf(element.source_id);
      const to = nameOf(element.target_id);
      if (from !== null && to !== null) facts.push(`From ${from} to ${to}`);
    } else {
      const boundary = nameOf(element.boundary_id);
      if (boundary !== null) facts.push(`In ${boundary}`);
    }
    items.push({
      id: element.id,
      group: element.type === 'external_entity' ? 'external_entity' : element.type,
      typeLabel: TYPE_LABELS[element.type],
      title: element.name,
      rationale: element.rationale,
      citations: element.citations,
      flags: element.flags,
      facts,
    });
  }
  for (const asset of draft.assets) {
    const holders = asset.held_by.map((id) => nameOf(id)).filter((name): name is string => name !== null);
    items.push({
      id: asset.id,
      group: 'asset',
      typeLabel: 'Asset',
      title: asset.name,
      rationale: asset.rationale,
      citations: asset.citations,
      flags: [],
      facts: [asset.description, ...(holders.length > 0 ? [`Held by ${holders.join(', ')}`] : [])],
    });
  }
  for (const assumption of draft.assumptions) {
    items.push({
      id: assumption.id,
      group: 'assumption',
      typeLabel: 'Assumption',
      title: assumption.statement,
      rationale: assumption.rationale,
      citations: assumption.citations,
      flags: [],
      facts: [],
    });
  }
  return GROUP_ORDER.flatMap((group) => items.filter((item) => item.group === group));
}
