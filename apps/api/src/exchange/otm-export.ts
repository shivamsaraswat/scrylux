import { NODE_SIZE, OTM_EXPORT, SCRYLUX_FORMAT_VERSION, type ElementRecord, type MitigationRecord, type ThreatRecord } from '@scrylux/core';
import type { Snapshot } from '../snapshot.js';
import { shorten } from './import/notes.js';
import { sortElements, sortMitigations, sortThreats } from './order.js';

// The OTM 0.2.0 file an export writes (contracts/otm-mapping.md, "Export"). The standard fields describe the model in
// OTM's own terms, so other tools can read it: trust zones, components, data flows, threats, mitigations and their
// states. Everything OTM has no field for is kept in `attributes.scrylux` of each object, which is what lets Scrylux read
// its own file back without losing anything (FR-011). OTM requires a few values Scrylux does not have; they are the
// constants of OTM_EXPORT, each documented in docs/formats/otm.md. The order is the Scrylux file's, so two exports of an
// unchanged model differ only in the export time (FR-005).

type Obj = Record<string, unknown>;

export interface ExportedOtm {
  otmVersion: '0.2.0';
  project: Obj;
  representations: Obj[];
  trustZones: Obj[];
  components: Obj[];
  dataflows: Obj[];
  threats: Obj[];
  mitigations: Obj[];
}

const OUTSIDE = OTM_EXPORT.outsideZone.id;
const MAX_NAME = 200;

const isNumber = (value: unknown): value is number => typeof value === 'number';

// Where an element is drawn, as an OTM representation of the one diagram, or nothing if it was never placed.
function representationOf(element: ElementRecord): Obj[] | undefined {
  const layout = element.layout;
  if (layout === null || !isNumber(layout.x) || !isNumber(layout.y)) return undefined;
  const position = { x: layout.x, y: layout.y };
  const size =
    element.type === 'trust_boundary'
      ? isNumber(layout.width) && isNumber(layout.height)
        ? { width: layout.width, height: layout.height }
        : undefined
      : element.type === 'data_flow'
        ? undefined
        : NODE_SIZE[element.type];
  if (size === undefined) return undefined;
  return [{ representation: 'diagram', id: `${element.id}-shape`, position, size }];
}

function tagsOf(element: ElementRecord): string[] | undefined {
  const tags = element.properties.tags;
  return Array.isArray(tags) && tags.length > 0 ? (tags as string[]) : undefined;
}

function flagsOf(element: ElementRecord): Record<string, boolean> {
  const flags = element.properties.flags;
  if (typeof flags !== 'object' || flags === null || Array.isArray(flags)) return {};
  return Object.fromEntries(Object.entries(flags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as Record<string, boolean>;
}

// The first line of a mitigation's description is its OTM name; the description is kept whole.
function mitigationName(mitigation: MitigationRecord): string {
  const line = mitigation.description.split('\n').find((candidate) => candidate.trim() !== '') ?? mitigation.description;
  return shorten(line.trim(), MAX_NAME).text;
}

function group<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    if (id !== null) grouped.set(id, [...(grouped.get(id) ?? []), item]);
  }
  return grouped;
}

export function buildOtmFile(snapshot: Snapshot, exportedAt: Date): ExportedOtm {
  const elements = sortElements(snapshot.elements);
  const threats = sortThreats(snapshot.threats, elements.position);
  const mitigations = sortMitigations(snapshot.mitigations, threats.position);
  const mitigationsOf = group(mitigations, (mitigation) => mitigation.threat_id);
  const threatsOf = group(threats.sorted, (threat) => threat.element_id);

  const reference = (threat: ThreatRecord): Obj => {
    const attached = mitigationsOf.get(threat.id) ?? [];
    return {
      threat: threat.id,
      state: OTM_EXPORT.threatStates[threat.status],
      ...(attached.length === 0
        ? {}
        : { mitigations: attached.map((mitigation) => ({ mitigation: mitigation.id, state: OTM_EXPORT.mitigationStates[mitigation.status] })) }),
    };
  };
  const referencesOf = (element: ElementRecord): { threats?: Obj[] } => {
    const own = threatsOf.get(element.id) ?? [];
    return own.length === 0 ? {} : { threats: own.map(reference) };
  };

  const boundaries = elements.sorted.filter((element) => element.type === 'trust_boundary');
  const nodes = elements.sorted.filter((element) => element.type !== 'trust_boundary' && element.type !== 'data_flow');
  const flows = elements.sorted.filter((element) => element.type === 'data_flow');

  const trustZones: Obj[] = boundaries.map((boundary) => {
    const representations = representationOf(boundary);
    return {
      id: boundary.id,
      name: boundary.name,
      type: 'trust-boundary',
      risk: { trustRating: OTM_EXPORT.trustRating },
      ...(boundary.parent_boundary_id === null ? {} : { parent: { trustZone: boundary.parent_boundary_id } }),
      ...(representations === undefined ? {} : { representations }),
      attributes: { scrylux: { layout: boundary.layout, parent_boundary_id: boundary.parent_boundary_id } },
    };
  });
  // OTM wants every component in a zone, so a node outside every boundary goes in a zone of its own, which is written
  // only when needed.
  if (nodes.some((node) => node.parent_boundary_id === null)) {
    trustZones.push({
      id: OUTSIDE,
      name: OTM_EXPORT.outsideZone.name,
      type: 'trust-boundary',
      risk: { trustRating: OTM_EXPORT.trustRating },
      attributes: { scrylux: { outside: true } },
    });
  }

  const components: Obj[] = nodes.map((node) => {
    const tags = tagsOf(node);
    const representations = representationOf(node);
    return {
      id: node.id,
      name: node.name,
      type: OTM_EXPORT.componentTypes[node.type as keyof typeof OTM_EXPORT.componentTypes],
      parent: { trustZone: node.parent_boundary_id ?? OUTSIDE },
      ...(tags === undefined ? {} : { tags }),
      ...(representations === undefined ? {} : { representations }),
      ...referencesOf(node),
      attributes: { scrylux: { type: node.type, flags: flagsOf(node), layout: node.layout, parent_boundary_id: node.parent_boundary_id } },
    };
  });

  const dataflows: Obj[] = flows.map((flow) => {
    const tags = tagsOf(flow);
    return {
      id: flow.id,
      name: flow.name,
      bidirectional: false,
      source: flow.source_element_id,
      destination: flow.target_element_id,
      ...(tags === undefined ? {} : { tags }),
      ...referencesOf(flow),
      attributes: { scrylux: { flags: flagsOf(flow) } },
    };
  });

  return {
    otmVersion: '0.2.0',
    project: {
      name: snapshot.model.name,
      id: snapshot.model.id,
      description: null,
      attributes: {
        scrylux: { format_version: SCRYLUX_FORMAT_VERSION, exported_at: exportedAt.toISOString(), status: snapshot.model.status, methodology: snapshot.model.methodology },
      },
    },
    representations: [{ name: 'Diagram', id: 'diagram', type: 'diagram' }],
    trustZones,
    components,
    dataflows,
    threats: threats.sorted.map((threat) => ({
      id: threat.id,
      name: threat.title,
      description: threat.description,
      categories: [threat.category],
      risk: { likelihood: OTM_EXPORT.risk[threat.likelihood], impact: OTM_EXPORT.risk[threat.impact] },
      attributes: {
        scrylux: {
          element_id: threat.element_id,
          likelihood: threat.likelihood,
          impact: threat.impact,
          status: threat.status,
          status_reason: threat.status_reason,
          origin: threat.origin,
          library_ref: threat.library_ref,
          stale: threat.stale,
        },
      },
    })),
    mitigations: mitigations.map((mitigation) => ({
      id: mitigation.id,
      name: mitigationName(mitigation),
      description: mitigation.description,
      riskReduction: OTM_EXPORT.riskReduction,
      attributes: { scrylux: { threat_id: mitigation.threat_id, status: mitigation.status, external_ref: mitigation.external_ref } },
    })),
  };
}
