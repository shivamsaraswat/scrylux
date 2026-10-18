import {
  ELEMENT_FLAGS,
  RISK_LEVELS,
  STRIDE_CATEGORIES,
  TYPE_LABELS,
  absoluteRects,
  describeStale,
  elementPropertiesSchema,
  flagLabel,
  lifecycleGap,
  resolveLayout,
  summarizeThreats,
  type ElementRecord,
  type ElementType,
  type Impact,
  type LifecycleGap,
  type Likelihood,
  type MitigationRecord,
  type MitigationStatus,
  type RiskLevel,
  type StrideCategory,
  type ThreatOrigin,
  type ThreatRecord,
  type ThreatStatus,
  type ThreatSummary,
} from '@scrylux/core';
import { computeFlowContexts } from '../rule-engine/flow-context.js';
import type { Snapshot } from '../snapshot.js';

// The report model (data-model.md §2): everything a report says, worked out once, in the order it is said. Both
// renderers draw only from this, so the Markdown and the HTML cannot differ (FR-002). The model holds the user's text
// exactly as stored; each renderer escapes it for its own format. It is pure: no clock, no I/O, no randomness, so
// the same snapshot always gives the same report (FR-013).

export interface ReportHeader {
  threatModelName: string;
  projectName: string;
  methodology: string;
  threatModelStatus: string;
  // The one instant a report is stamped with, to the minute, in UTC.
  exportedAt: string;
  counts: { elements: number; threats: number; mitigations: number };
}

export interface ReportMitigation {
  // Used to count and to break ties; never printed.
  id: string;
  description: string;
  status: MitigationStatus;
  statusLabel: string;
  ticket: { text: string; href: string | null } | null;
}

export interface ReportThreat {
  // Used to count and to break ties; never printed.
  id: string;
  title: string;
  category: StrideCategory;
  description: string;
  likelihood: Likelihood;
  impact: Impact;
  risk: RiskLevel;
  status: ThreatStatus;
  statusLabel: string;
  statusReason: string | null;
  origin: ThreatOrigin;
  originLabel: string;
  stale: string | null;
  gap: LifecycleGap | null;
  mitigations: ReportMitigation[];
}

export interface ReportFlag {
  label: string;
  value: 'Yes' | 'No' | 'Not assessed';
}

// One end of a data flow: which element, and the trust boundary it is in (null: none).
export interface FlowEnd {
  ref: string;
  name: string;
  boundary: string | null;
}

export interface ReportFlow {
  source: FlowEnd;
  target: FlowEnd;
  // The rule engine's own answer: the two ends are not inside the same set of boundaries (M2 FR-010b).
  crosses: boolean;
}

export interface ReportElement {
  // `E1`, `E2`, ... in the order the sections appear (research #12).
  ref: string;
  id: string;
  type: ElementType;
  typeLabel: string;
  name: string;
  // The name, with the reference added when another element has exactly the same name.
  displayName: string;
  // Technology tags as stored, in order.
  tags: string[];
  // One entry per security flag of the element's type, in the vocabulary's order.
  flags: ReportFlag[];
  // Only on a data flow.
  flow: ReportFlow | null;
  // A trust boundary's own threats are its group's `ownThreats`, so this is always empty for one.
  threats: ReportThreat[];
}

export interface BoundaryGroup {
  // Null for the group of elements outside any trust boundary.
  boundary: ReportElement | null;
  // The names of the boundaries from the outermost to this one; empty for the outside group.
  path: string[];
  ownThreats: ReportThreat[];
  elements: ReportElement[];
  children: BoundaryGroup[];
}

export interface DiagramShape {
  id: string;
  ref: string;
  type: ElementType;
  displayName: string;
  // On the diagram itself, as the canvas draws it.
  x: number;
  y: number;
  width: number;
  height: number;
  // How many trust boundaries the shape sits inside.
  depth: number;
}

export interface DiagramFlow {
  id: string;
  ref: string;
  displayName: string;
  sourceId: string;
  sourceRef: string;
  targetId: string;
  targetRef: string;
  // Sideways shift for a flow that shares its two ends with others, centred on zero (research #11).
  offset: number;
}

export interface DiagramModel {
  nodes: DiagramShape[];
  // Outermost first, so an inner boundary is drawn over the one around it.
  boundaries: DiagramShape[];
  flows: DiagramFlow[];
  // Null when there is nothing to draw.
  viewBox: { x: number; y: number; width: number; height: number } | null;
}

export interface Report {
  header: ReportHeader;
  summary: ThreatSummary;
  diagram: DiagramModel;
  groups: BoundaryGroup[];
  outside: BoundaryGroup;
  unlinked: ReportThreat[];
}

// ---- ordering ----

// Unicode code point order. `<` on strings compares UTF-16 units, which puts a character outside the basic plane
// before one from U+E000 to U+FFFF; and localeCompare depends on the machine's locale data. Neither would give two
// machines the same file (FR-013).
function compareCodePoints(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) {
      const x = a.codePointAt(i) as number;
      const y = b.codePointAt(i) as number;
      return x < y ? -1 : x > y ? 1 : 0;
    }
  }
  return a.length - b.length;
}

const TYPE_ORDER: readonly ElementType[] = ['external_entity', 'process', 'data_store', 'data_flow', 'trust_boundary'];

const byNameThenId = (a: ElementRecord, b: ElementRecord): number => compareCodePoints(a.name, b.name) || compareCodePoints(a.id, b.id);
const byTypeThenName = (a: ElementRecord, b: ElementRecord): number =>
  TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || byNameThenId(a, b);
// The order the canvas receives elements in, and so the order its unplaced ones are laid out in.
const byCreation = (a: ElementRecord, b: ElementRecord): number =>
  compareCodePoints(a.created_at, b.created_at) || compareCodePoints(a.id, b.id);

function compareThreats(a: ThreatRecord, b: ThreatRecord): number {
  return (
    RISK_LEVELS.indexOf(b.risk) - RISK_LEVELS.indexOf(a.risk) ||
    STRIDE_CATEGORIES.indexOf(a.category) - STRIDE_CATEGORIES.indexOf(b.category) ||
    compareCodePoints(a.title, b.title) ||
    compareCodePoints(a.id, b.id)
  );
}

const compareMitigations = (a: MitigationRecord, b: MitigationRecord): number =>
  compareCodePoints(a.description, b.description) || compareCodePoints(a.id, b.id);

// ---- wording ----

const THREAT_MODEL_STATUS_LABELS: Record<string, string> = { draft: 'Draft', in_review: 'In review', approved: 'Approved' };
export const STATUS_LABELS: Record<ThreatStatus, string> = {
  open: 'Open',
  mitigated: 'Mitigated',
  accepted: 'Accepted',
  not_applicable: 'Not applicable',
};
const ORIGIN_LABELS: Record<ThreatOrigin, string> = { manual: 'Manual', rule: 'Rule-generated', ai: 'AI-drafted' };
const MITIGATION_STATUS_LABELS: Record<MitigationStatus, string> = {
  proposed: 'Proposed',
  implemented: 'Implemented',
  verified: 'Verified',
};

// What a threat is missing for the status it has (core's lifecycleGap), in words, for a reader of the report.
export const GAP_TEXT: Record<LifecycleGap, string> = {
  reason_missing: 'a reason for this status',
  no_implemented_mitigation: 'an implemented or verified mitigation',
};

// `Yes (from outside any trust boundary to Internal network)` or `No`. The boundary names are user text, so the caller
// says how to escape them.
export function crossingText(flow: ReportFlow, escape: (text: string) => string): string {
  if (!flow.crosses) return 'No';
  const where = (end: FlowEnd): string => (end.boundary === null ? 'outside any trust boundary' : escape(end.boundary));
  return `Yes (from ${where(flow.source)} to ${where(flow.target)})`;
}

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? '' : 's'}`;

// `9 elements, 13 threats, 1 mitigation`: the one line of the header that says how much there is.
export function contentsLine(counts: ReportHeader['counts']): string {
  return `${plural(counts.elements, 'element')}, ${plural(counts.threats, 'threat')}, ${plural(counts.mitigations, 'mitigation')}`;
}

// `2026-10-10 23:59 UTC`.
function formatInstant(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

// The same test the threat list uses for a ticket link (TicketLink.tsx): only http and https addresses are links.
function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// ---- building ----

const FLOW_OFFSET_STEP = 12;
// All the flows that share two shapes together spread no wider than this, so every line still meets both shapes (a node
// is 60 units high). Past five flows the lines are closer than the step, and lines that close are all that can be drawn.
const FLOW_MAX_SPREAD = 48;
const VIEW_BOX_MARGIN = 40;

interface Draft {
  boundary: ElementRecord | null;
  path: string[];
  elements: ElementRecord[];
  children: Draft[];
}

export function buildReport(snapshot: Snapshot, exportedAt: Date): Report {
  const elements = [...snapshot.elements].sort(byCreation);
  const byId = new Map(elements.map((element) => [element.id, element]));

  // Stored membership: an element belongs to the boundary named in `parent_boundary_id`, if that is a boundary
  // that exists (the same rule the canvas uses).
  const parentOf = (element: ElementRecord): string | null => {
    const parent = element.parent_boundary_id === null ? undefined : byId.get(element.parent_boundary_id);
    return parent?.type === 'trust_boundary' ? parent.id : null;
  };
  // The boundaries around an element, innermost first. The database forbids cycles; the seen-set keeps a corrupt row
  // from looping.
  const chainOf = (id: string | null): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let parent = id === null ? null : parentOf(byId.get(id) as ElementRecord);
    while (parent !== null && !seen.has(parent)) {
      chain.push(parent);
      seen.add(parent);
      parent = parentOf(byId.get(parent) as ElementRecord);
    }
    return chain;
  };

  // A data flow belongs to the innermost boundary that holds both of its ends, or to none (research #6).
  const flowGroupOf = (flow: ElementRecord): string | null => {
    const sourceChain = chainOf(flow.source_element_id);
    const targetChain = new Set(chainOf(flow.target_element_id));
    return sourceChain.find((id) => targetChain.has(id)) ?? null;
  };
  const groupKeyOf = (element: ElementRecord): string | null => (element.type === 'data_flow' ? flowGroupOf(element) : parentOf(element));

  // ---- the group tree, as records ----
  const members = new Map<string | null, ElementRecord[]>();
  const nested = new Map<string | null, ElementRecord[]>();
  for (const element of elements) {
    if (element.type === 'trust_boundary') nested.set(parentOf(element), [...(nested.get(parentOf(element)) ?? []), element]);
    else members.set(groupKeyOf(element), [...(members.get(groupKeyOf(element)) ?? []), element]);
  }
  const draftFor = (boundary: ElementRecord | null, parentPath: string[]): Draft => {
    const path = boundary === null ? [] : [...parentPath, boundary.name];
    const key = boundary?.id ?? null;
    return {
      boundary,
      path,
      elements: [...(members.get(key) ?? [])].sort(byTypeThenName),
      // The group of elements outside any boundary has none nested in it: the top-level boundaries sit beside it.
      children: boundary === null ? [] : [...(nested.get(key) ?? [])].sort(byNameThenId).map((child) => draftFor(child, path)),
    };
  };
  const topDrafts = [...(nested.get(null) ?? [])].sort(byNameThenId).map((boundary) => draftFor(boundary, []));
  const outsideDraft = draftFor(null, []);

  // ---- references, depth first, in the order the sections appear ----
  const refs = new Map<string, string>();
  const number = (element: ElementRecord): void => {
    refs.set(element.id, `E${refs.size + 1}`);
  };
  const walk = (draft: Draft): void => {
    if (draft.boundary !== null) number(draft.boundary);
    draft.elements.forEach(number);
    draft.children.forEach(walk);
  };
  topDrafts.forEach(walk);
  walk(outsideDraft);
  const refOf = (id: string): string => refs.get(id) as string;

  const nameCounts = new Map<string, number>();
  for (const element of elements) nameCounts.set(element.name, (nameCounts.get(element.name) ?? 0) + 1);
  const displayNameOf = (element: ElementRecord): string =>
    (nameCounts.get(element.name) ?? 0) > 1 ? `${element.name} (${refOf(element.id)})` : element.name;

  // ---- threats and mitigations ----
  const mitigationsOf = new Map<string, MitigationRecord[]>();
  for (const mitigation of snapshot.mitigations) {
    mitigationsOf.set(mitigation.threat_id, [...(mitigationsOf.get(mitigation.threat_id) ?? []), mitigation]);
  }
  const reportThreat = (threat: ThreatRecord): ReportThreat => {
    const stored = [...(mitigationsOf.get(threat.id) ?? [])].sort(compareMitigations);
    return {
      id: threat.id,
      title: threat.title,
      category: threat.category,
      description: threat.description,
      likelihood: threat.likelihood,
      impact: threat.impact,
      risk: threat.risk,
      status: threat.status,
      statusLabel: STATUS_LABELS[threat.status],
      statusReason: threat.status_reason,
      origin: threat.origin,
      originLabel: ORIGIN_LABELS[threat.origin] ?? threat.origin,
      stale: threat.stale === null ? null : describeStale(threat.stale),
      gap: lifecycleGap(threat, stored),
      mitigations: stored.map((mitigation) => ({
        id: mitigation.id,
        description: mitigation.description,
        status: mitigation.status,
        statusLabel: MITIGATION_STATUS_LABELS[mitigation.status],
        ticket:
          mitigation.external_ref === null
            ? null
            : { text: mitigation.external_ref, href: isWebUrl(mitigation.external_ref) ? mitigation.external_ref : null },
      })),
    };
  };
  const threatsOf = new Map<string | null, ThreatRecord[]>();
  for (const threat of snapshot.threats) {
    // A threat naming an element that is not there cannot be stored; if one ever were, it is still reported.
    const key = threat.element_id !== null && byId.has(threat.element_id) ? threat.element_id : null;
    threatsOf.set(key, [...(threatsOf.get(key) ?? []), threat]);
  }
  const threatsFor = (id: string | null): ReportThreat[] => [...(threatsOf.get(id) ?? [])].sort(compareThreats).map(reportThreat);

  // ---- what an element is ----
  // Tags and flags as stored, read through the vocabulary the editor writes. A value that does not parse (a row from
  // before the vocabulary, or from a newer one) gives no tags and nothing assessed: a report never fails on it.
  const propertiesOf = (element: ElementRecord): { tags: string[]; flags: ReportFlag[] } => {
    const parsed = elementPropertiesSchema(element.type).safeParse(element.properties);
    const stored = parsed.success ? (parsed.data.flags ?? {}) : {};
    const names: readonly string[] = ELEMENT_FLAGS[element.type];
    return {
      tags: parsed.success ? (parsed.data.tags ?? []) : [],
      flags: names.map((flag) => ({ label: flagLabel(flag), value: stored[flag] === true ? 'Yes' : stored[flag] === false ? 'No' : 'Not assessed' })),
    };
  };
  const flowRecords = elements.filter((element) => element.type === 'data_flow');
  const crossings: ReadonlyMap<string, { crosses_trust_boundary: boolean }> =
    flowRecords.length === 0 ? new Map<string, { crosses_trust_boundary: boolean }>() : computeFlowContexts(elements);
  const endOf = (id: string | null): FlowEnd => {
    const end = id === null ? undefined : byId.get(id);
    const innermost = end === undefined ? undefined : chainOf(end.id)[0];
    return {
      ref: end === undefined ? '' : refOf(end.id),
      name: end?.name ?? '',
      boundary: innermost === undefined ? null : (byId.get(innermost)?.name ?? null),
    };
  };

  // ---- sections ----
  const reportElement = (element: ElementRecord): ReportElement => ({
    ref: refOf(element.id),
    id: element.id,
    type: element.type,
    typeLabel: TYPE_LABELS[element.type],
    name: element.name,
    displayName: displayNameOf(element),
    ...propertiesOf(element),
    flow:
      element.type === 'data_flow'
        ? {
            source: endOf(element.source_element_id),
            target: endOf(element.target_element_id),
            crosses: crossings.get(element.id)?.crosses_trust_boundary ?? false,
          }
        : null,
    threats: element.type === 'trust_boundary' ? [] : threatsFor(element.id),
  });
  const group = (draft: Draft): BoundaryGroup => ({
    boundary: draft.boundary === null ? null : reportElement(draft.boundary),
    path: draft.path,
    ownThreats: draft.boundary === null ? [] : threatsFor(draft.boundary.id),
    elements: draft.elements.map(reportElement),
    children: draft.children.map(group),
  });

  // ---- the diagram, drawn where the canvas draws it ----
  const rects = absoluteRects(elements, resolveLayout(elements));
  const shape = (element: ElementRecord): DiagramShape => ({
    id: element.id,
    ref: refOf(element.id),
    type: element.type,
    displayName: displayNameOf(element),
    ...(rects.get(element.id) as { x: number; y: number; width: number; height: number }),
    depth: chainOf(element.id).length,
  });
  const shapes = elements.filter((element) => element.type !== 'data_flow').map(shape);
  const refNumber = (ref: string): number => Number(ref.slice(1));
  const inReportOrder = (a: DiagramShape, b: DiagramShape): number => refNumber(a.ref) - refNumber(b.ref);

  // Flows that join the same two nodes, in either direction, are spread apart so none hides another.
  const pairs = new Map<string, ElementRecord[]>();
  for (const flow of flowRecords) {
    const key = [flow.source_element_id, flow.target_element_id].sort().join('|');
    pairs.set(key, [...(pairs.get(key) ?? []), flow]);
  }
  const offsets = new Map<string, number>();
  for (const sharing of pairs.values()) {
    sharing.sort((a, b) => refNumber(refOf(a.id)) - refNumber(refOf(b.id)));
    const step = Math.min(FLOW_OFFSET_STEP, FLOW_MAX_SPREAD / Math.max(1, sharing.length - 1));
    sharing.forEach((flow, index) => offsets.set(flow.id, (index - (sharing.length - 1) / 2) * step));
  }
  const flows: DiagramFlow[] = flowRecords
    .map((flow) => ({
      id: flow.id,
      ref: refOf(flow.id),
      displayName: displayNameOf(flow),
      sourceId: flow.source_element_id as string,
      sourceRef: flow.source_element_id === null ? '' : (refs.get(flow.source_element_id) ?? ''),
      targetId: flow.target_element_id as string,
      targetRef: flow.target_element_id === null ? '' : (refs.get(flow.target_element_id) ?? ''),
      offset: offsets.get(flow.id) ?? 0,
    }))
    .sort((a, b) => refNumber(a.ref) - refNumber(b.ref));

  const drawn = shapes;
  const viewBox =
    drawn.length === 0
      ? null
      : (() => {
          const minX = Math.min(...drawn.map((s) => s.x));
          const minY = Math.min(...drawn.map((s) => s.y));
          const maxX = Math.max(...drawn.map((s) => s.x + s.width));
          const maxY = Math.max(...drawn.map((s) => s.y + s.height));
          return {
            x: minX - VIEW_BOX_MARGIN,
            y: minY - VIEW_BOX_MARGIN,
            width: maxX - minX + 2 * VIEW_BOX_MARGIN,
            height: maxY - minY + 2 * VIEW_BOX_MARGIN,
          };
        })();

  return {
    header: {
      threatModelName: snapshot.model.name,
      projectName: snapshot.project.name,
      methodology: snapshot.model.methodology,
      threatModelStatus: THREAT_MODEL_STATUS_LABELS[snapshot.model.status] ?? snapshot.model.status,
      exportedAt: formatInstant(exportedAt),
      counts: { elements: snapshot.elements.length, threats: snapshot.threats.length, mitigations: snapshot.mitigations.length },
    },
    summary: summarizeThreats(snapshot.threats),
    diagram: {
      nodes: shapes.filter((s) => s.type !== 'trust_boundary').sort(inReportOrder),
      boundaries: shapes.filter((s) => s.type === 'trust_boundary').sort((a, b) => a.depth - b.depth || inReportOrder(a, b)),
      flows,
      viewBox,
    },
    groups: topDrafts.map(group),
    outside: group(outsideDraft),
    unlinked: threatsFor(null),
  };
}
