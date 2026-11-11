import { TYPE_LABELS, flagLabel, type CitationRecord, type DraftRecord, type ItemReview } from '@scrylux/core';
import { time } from '../components/job-format.js';

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
  /** Where it stands in the review, in words: "Undecided", "Accepted by ada on …" (Phase 3 Milestone 5, FR-001). */
  status: string;
  /** How it compares with the threat model now, in words; null once it is accepted (FR-002). */
  comparison: string | null;
  /** What differs from the record it matched, one line each (FR-002). */
  differences: string[];
  /** What it needs before it can be accepted: "Needs API in the model first" (FR-003). */
  needs: string[];
  review: ItemReview;
}

const COMPARISON_TEXT = { new: 'New', matched: 'Already in the model', several: 'Several in the model; treated as new' } as const;
const yesNo = (value: boolean): string => (value ? 'Yes' : 'No');

/** The short form of a status, for the list: how an item stands, or how it compares if it is not decided. */
export const shortStatus = (item: DraftItem): string => (item.review.state === 'undecided' ? (item.comparison ?? '') : item.review.state === 'accepted' ? 'Accepted' : 'Rejected');

function statusOf(review: ItemReview): string {
  if (review.state === 'undecided') return 'Undecided';
  const how = review.state === 'accepted' && review.outcome === 'matched' ? ' (it was already in the model)' : '';
  const who = review.decided_by === null ? '' : ` by ${review.decided_by.username}`;
  const when = review.decided_at === null ? '' : ` on ${time(review.decided_at)}`;
  return `${review.state === 'accepted' ? 'Accepted' : 'Rejected'}${how}${who}${when}`;
}

/** A citation that still points at a chunk. One whose source was deleted is shown as such and does not count (FR-054). */
export const remaining = (citations: readonly CitationRecord[]): CitationRecord[] => citations.filter((citation) => citation.chunk !== null);

/** Every item of a draft, grouped in the order of GROUP_ORDER and in the order of the answer within a group. */
export function draftItems(draft: DraftRecord): DraftItem[] {
  const names = new Map<string, string>(draft.elements.map((element) => [element.id, element.name]));
  const nameOf = (id: string | null): string | null => (id === null ? null : (names.get(id) ?? null));
  const reviewOf = (id: string): Pick<DraftItem, 'status' | 'comparison' | 'differences' | 'needs' | 'review'> => {
    const review = draft.review[id] as ItemReview;
    const differences = review.differences;
    return {
      status: statusOf(review),
      comparison: review.comparison === null ? null : COMPARISON_TEXT[review.comparison],
      differences:
        differences === null
          ? []
          : [
              ...differences.flags.map((flag) => `${flagLabel(flag.flag)}: proposed ${yesNo(flag.proposed)}, ${flag.current === null ? 'not assessed' : yesNo(flag.current)}`),
              ...(differences.boundary ? ['Boundary differs'] : []),
              ...(differences.endpoints ? ['Ends differ'] : []),
              ...(differences.holders_missing > 0 ? [`${differences.holders_missing === 1 ? '1 holder is' : `${differences.holders_missing} holders are`} not held yet`] : []),
            ],
      needs: (review.needs ?? []).map((need) => `Needs ${nameOf(need.item_id) ?? 'an item'} in the model first`),
      review,
    };
  };

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
      ...reviewOf(element.id),
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
      ...reviewOf(asset.id),
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
      ...reviewOf(assumption.id),
    });
  }
  return GROUP_ORDER.flatMap((group) => items.filter((item) => item.group === group));
}
