import { STRIDE_CATEGORIES, type ElementType } from '@scrylux/core';

// The order of an export (research #3, data-model.md "Export order"). It depends only on what a record is: every row
// one import inserts gets the same created_at, so sorting by it would leave the re-export in random id order and break
// the lossless round trip (FR-004). Comparisons are by code point, never by locale, and the id breaks every tie.

const KIND_RANK: Record<ElementType, number> = {
  trust_boundary: 0,
  external_entity: 1,
  process: 2,
  data_store: 3,
  data_flow: 4,
};

const STRIDE_RANK = new Map<string, number>(STRIDE_CATEGORIES.map((category, index) => [category, index]));
const LAST = Number.MAX_SAFE_INTEGER;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function positions<T extends { id: string }>(sorted: readonly T[]): Map<string, number> {
  return new Map(sorted.map((item, index) => [item.id, index]));
}

export function sortElements<T extends { id: string; type: ElementType; name: string }>(
  elements: readonly T[],
): { sorted: T[]; position: Map<string, number> } {
  const sorted = [...elements].sort(
    (a, b) => KIND_RANK[a.type] - KIND_RANK[b.type] || compareText(a.name, b.name) || compareText(a.id, b.id),
  );
  return { sorted, position: positions(sorted) };
}

// A threat on no element comes after every element's threats.
export function sortThreats<T extends { id: string; element_id: string | null; category: string; title: string }>(
  threats: readonly T[],
  elementPosition: ReadonlyMap<string, number>,
): { sorted: T[]; position: Map<string, number> } {
  const rank = (threat: T): number => (threat.element_id === null ? LAST : (elementPosition.get(threat.element_id) ?? LAST));
  const category = (threat: T): number => STRIDE_RANK.get(threat.category) ?? LAST;
  const sorted = [...threats].sort(
    (a, b) => rank(a) - rank(b) || category(a) - category(b) || compareText(a.title, b.title) || compareText(a.id, b.id),
  );
  return { sorted, position: positions(sorted) };
}

export function sortMitigations<T extends { id: string; threat_id: string; description: string }>(
  mitigations: readonly T[],
  threatPosition: ReadonlyMap<string, number>,
): T[] {
  const rank = (mitigation: T): number => threatPosition.get(mitigation.threat_id) ?? LAST;
  return [...mitigations].sort((a, b) => rank(a) - rank(b) || compareText(a.description, b.description) || compareText(a.id, b.id));
}
