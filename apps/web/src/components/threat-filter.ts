import { RISK_LEVELS, THREAT_STATUSES, compareByRisk, uuid, type RiskLevel, type ThreatRecord, type ThreatStatus } from '@scrylux/core';

// The threat list's filters and order, carried in the page's address so a filtered list survives a reload and can
// be shared as a link (spec FR-019, FR-020; data-model.md §5). Nothing here is stored on the server. The address
// is user input, so every value is checked against what it may be, and anything else is dropped without a message.

export interface ThreatFilter {
  element: { kind: 'any' } | { kind: 'none' } | { kind: 'element'; id: string };
  // Empty means every status, or every risk level.
  statuses: ThreatStatus[];
  risks: RiskLevel[];
  origin: 'manual' | 'rule' | null;
  staleOnly: boolean;
  sort: 'created' | 'risk';
}

export const NO_FILTER: ThreatFilter = { element: { kind: 'any' }, statuses: [], risks: [], origin: null, staleOnly: false, sort: 'created' };

// The values that are present, once each, in the order the application lists them.
const inOrder = <T extends string>(all: readonly T[], wanted: readonly string[]): T[] => all.filter((value) => wanted.includes(value));

export function parseThreatFilter(params: URLSearchParams): ThreatFilter {
  const element = params.get('element');
  const origin = params.get('origin');
  return {
    element:
      element === 'none'
        ? { kind: 'none' }
        : element !== null && uuid.safeParse(element).success
          ? { kind: 'element', id: element }
          : { kind: 'any' },
    statuses: inOrder(THREAT_STATUSES, params.getAll('status')),
    risks: inOrder(RISK_LEVELS, params.getAll('risk')),
    origin: origin === 'manual' || origin === 'rule' ? origin : null,
    staleOnly: params.get('stale') === '1',
    sort: params.get('sort') === 'risk' ? 'risk' : 'created',
  };
}

// A fixed order and no defaults, so the same filter is always the same address.
export function toSearchParams(filter: ThreatFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.element.kind === 'none') params.set('element', 'none');
  else if (filter.element.kind === 'element') params.set('element', filter.element.id);
  for (const status of filter.statuses) params.append('status', status);
  for (const risk of filter.risks) params.append('risk', risk);
  if (filter.origin !== null) params.set('origin', filter.origin);
  if (filter.staleOnly) params.set('stale', '1');
  if (filter.sort === 'risk') params.set('sort', 'risk');
  return params;
}

export function isFiltered(filter: ThreatFilter): boolean {
  return toSearchParams(filter).size > 0;
}

// A threat must match every filter chosen. Without an order, the list keeps the server's (oldest first); the
// order by risk is a new array, so the list it was given is not changed.
export function applyThreatFilter(threats: readonly ThreatRecord[], filter: ThreatFilter): ThreatRecord[] {
  const { element, statuses, risks, origin, staleOnly } = filter;
  const kept = threats.filter(
    (threat) =>
      (element.kind === 'any' || (element.kind === 'none' ? threat.element_id === null : threat.element_id === element.id)) &&
      (statuses.length === 0 || statuses.includes(threat.status)) &&
      (risks.length === 0 || risks.includes(threat.risk)) &&
      (origin === null || threat.origin === origin) &&
      (!staleOnly || threat.stale !== null),
  );
  return filter.sort === 'risk' ? kept.sort(compareByRisk) : kept;
}
