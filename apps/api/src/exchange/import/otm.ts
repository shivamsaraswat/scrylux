import {
  OTM_COMPONENT_TYPES,
  OTM_EXPORT,
  OTM_MITIGATION_STATES,
  OTM_THREAT_STATES,
  OtmScrylux,
  ScryluxFileV1,
  type ImportNote,
  type Impact,
  type MitigationStatus,
  type OtmFile,
  type StrideCategory,
  type ThreatStatus,
} from '@scrylux/core';
import { z } from 'zod';
import { HttpError } from '../../v1/errors.js';
import { placeBoundary, placeNode } from './geometry.js';
import { adapters, hasText, letters, matchStride, note } from './notes.js';
import { parseWith, refuse } from './parse-with.js';
import type { ImportPlan, PlanElement, PlanMitigation, PlanThreat } from './plan.js';
import { planScrylux } from './scrylux.js';

// An OTM 0.2.0 file as a plan (contracts/otm-mapping.md). A file Scrylux wrote carries its own fields in
// `attributes.scrylux` and is read back strictly, as a Scrylux file would be (FR-011). A file from another tool is
// mapped by a fixed table, and everything it cannot carry over is listed in the notes (FR-012, FR-016).

type Obj = Record<string, unknown>;
type Zone = NonNullable<OtmFile['trustZones']>[number];
type Component = NonNullable<OtmFile['components']>[number];
type OtmThreat = NonNullable<OtmFile['threats']>[number];
type OtmMitigation = NonNullable<OtmFile['mitigations']>[number];
type Reference = NonNullable<Component['threats']>[number];
type Representation = NonNullable<Zone['representations']>[number];

const isRecord = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasEntries = (value: unknown): boolean => isRecord(value) && Object.keys(value).length > 0;

// A Scrylux file's mark: `project.attributes.scrylux.format_version`. Whoever sets it gets the strict rules, so claiming
// to be Scrylux's buys nothing (FR-008a).
function isScryluxFile(file: OtmFile): boolean {
  const attributes = file.project.attributes;
  const scrylux = isRecord(attributes) ? attributes.scrylux : undefined;
  return isRecord(scrylux) && 'format_version' in scrylux;
}

export function planOtm(file: OtmFile): ImportPlan {
  return isScryluxFile(file) ? planStrict(file) : planAdapted(file);
}

// ---------------------------------------------------------------------------------------------------------------------
// A file Scrylux wrote

const MISSING = (path: string): string =>
  `${path}.attributes.scrylux: missing; this file was changed outside Scrylux (remove project.attributes.scrylux to import it as another tool's file)`;

function planStrict(file: OtmFile): ImportPlan {
  const project = parseWith(OtmScrylux.project, (file.project.attributes as Obj).scrylux, ['file', 'project', 'attributes', 'scrylux']);

  // The attributes of one object, parsed strictly, or a refusal that says the file was edited.
  const attributesOf = <T>(owner: { attributes?: unknown }, collection: string, index: number, schema: z.ZodType<T>): T => {
    const attributes = owner.attributes;
    const scrylux = isRecord(attributes) ? attributes.scrylux : undefined;
    if (scrylux === undefined || scrylux === null) throw refuse(MISSING(`file.${collection}.${index}`));
    return parseWith(schema, scrylux, ['file', collection, index, 'attributes', 'scrylux']);
  };
  const stringTags = (tags: readonly (string | null)[] | null | undefined): string[] => (tags ?? []).filter((tag): tag is string => typeof tag === 'string');
  const properties = (tags: string[], flags: Record<string, boolean>): Obj => ({
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
  });

  const elements: Obj[] = [];
  const paths: string[] = [];
  const add = (element: Obj, path: string): void => {
    elements.push(element);
    paths.push(path);
  };
  (file.trustZones ?? []).forEach((zone, index) => {
    const attributes = attributesOf(zone, 'trustZones', index, OtmScrylux.zone);
    if ('outside' in attributes) return;
    add(
      { id: zone.id, type: 'trust_boundary', name: zone.name, properties: {}, layout: attributes.layout, parent_boundary_id: attributes.parent_boundary_id, source_element_id: null, target_element_id: null },
      `file.trustZones.${index}`,
    );
  });
  (file.components ?? []).forEach((component, index) => {
    const attributes = attributesOf(component, 'components', index, OtmScrylux.component);
    add(
      { id: component.id, type: attributes.type, name: component.name, properties: properties(stringTags(component.tags), attributes.flags), layout: attributes.layout, parent_boundary_id: attributes.parent_boundary_id, source_element_id: null, target_element_id: null },
      `file.components.${index}`,
    );
  });
  (file.dataflows ?? []).forEach((flow, index) => {
    const attributes = attributesOf(flow, 'dataflows', index, OtmScrylux.dataflow);
    add(
      { id: flow.id, type: 'data_flow', name: flow.name, properties: properties(stringTags(flow.tags), attributes.flags), layout: null, parent_boundary_id: null, source_element_id: flow.source, target_element_id: flow.destination },
      `file.dataflows.${index}`,
    );
  });
  const threats = (file.threats ?? []).map((threat, index) => ({
    id: threat.id,
    category: threat.categories?.[0] ?? '',
    title: threat.name,
    description: threat.description ?? '',
    ...attributesOf(threat, 'threats', index, OtmScrylux.threat),
  }));
  const mitigations = (file.mitigations ?? []).map((mitigation, index) => {
    const attributes = attributesOf(mitigation, 'mitigations', index, OtmScrylux.mitigation);
    return { id: mitigation.id, description: mitigation.description ?? '', ...attributes };
  });

  const raw = {
    format: 'scrylux',
    format_version: project.format_version,
    exported_at: project.exported_at,
    project: { name: file.project.name },
    threat_model: { name: file.project.name, methodology: project.methodology, status: project.status },
    elements,
    threats,
    mitigations,
  };

  // The file is read as the Scrylux file it says it is, so every field rule is the same one; a refusal names the OTM
  // object where it is, not the position it would have in a Scrylux file.
  const where = (message: string): string => message.replaceAll(/file\.elements\.(\d+)/g, (match, at: string) => paths[Number(at)] ?? match);
  let result: ImportPlan;
  try {
    result = planScrylux(parseWith(ScryluxFileV1, raw));
  } catch (err) {
    if (err instanceof HttpError) throw new HttpError(err.status, where(err.message));
    throw err;
  }
  result.models.forEach((model) => model.elements.forEach((element, at) => (element.path = paths[at] ?? element.path)));
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// A file from another tool

const { exact, externalEntity, dataStore } = OTM_COMPONENT_TYPES;
function nodeTypeOf(type: string): { type: 'external_entity' | 'process' | 'data_store'; defaulted: boolean } {
  const lower = type.toLowerCase();
  for (const [candidate, spellings] of Object.entries(exact) as ['external_entity' | 'process' | 'data_store', readonly string[]][]) {
    if (spellings.includes(lower)) return { type: candidate, defaulted: false };
  }
  if (externalEntity.some((keyword) => lower.includes(keyword))) return { type: 'external_entity', defaulted: false };
  if (dataStore.some((keyword) => lower.includes(keyword))) return { type: 'data_store', defaulted: false };
  return { type: 'process', defaulted: true };
}

function statusFrom<T extends string>(table: Readonly<Record<T, readonly string[]>>, state: string | null | undefined): T | null {
  if (!hasText(state)) return null;
  const wanted = letters(state);
  return (Object.keys(table) as T[]).find((status) => table[status].includes(wanted)) ?? null;
}

// OTM's 0 to 100 as Scrylux's three levels: under 34 is Low, under 67 Medium, and the rest High.
const level = (value: number): Impact => (value < 34 ? 'Low' : value < 67 ? 'Medium' : 'High');

interface ThreatInfo {
  category: StrideCategory | null;
  title: string;
  description: string;
  likelihood: Impact;
  impact: Impact;
}

function planAdapted(file: OtmFile): ImportPlan {
  const notes: ImportNote[] = [];
  const elements: PlanElement[] = [];
  const threats: PlanThreat[] = [];
  const mitigations: PlanMitigation[] = [];
  const { add: addNote, field, nameOf, longText, tagsOf } = adapters(notes);
  const content = (path: string, label: string, owner: { description?: string | null; attributes?: unknown }): void => {
    if (hasText(owner.description)) field(path, label, 'description');
    if (hasEntries(owner.attributes)) field(path, label, 'attributes');
  };

  // The one diagram Scrylux draws: the first representation of type "diagram". The others are noted.
  const representations = file.representations ?? [];
  const diagramAt = representations.findIndex((entry) => entry?.type === 'diagram');
  const diagramId = diagramAt >= 0 ? representations[diagramAt]?.id : undefined;
  representations.forEach((entry, index) => {
    if (entry !== null && index !== diagramAt) addNote(note(`file.representations.${index}`, 'not_imported.representation', entry.name ?? entry.id ?? undefined));
  });
  const placementOf = (list: readonly Representation[] | null | undefined): Representation | undefined => {
    const own = (list ?? []).filter((entry): entry is NonNullable<Representation> => entry !== null);
    return diagramId === undefined ? (diagramAt < 0 ? own.find((entry) => entry.position) : undefined) : own.find((entry) => entry.representation === diagramId);
  };

  (file.assets ?? []).forEach((asset, index) => {
    if (asset !== null) addNote(note(`file.assets.${index}`, 'not_imported.asset', asset.name ?? asset.id ?? undefined));
  });

  const project = file.project;
  for (const [name, present] of [
    ['description', hasText(project.description)],
    ['owner', hasText(project.owner)],
    ['ownerContact', hasText(project.ownerContact)],
    ['tags', (project.tags ?? []).length > 0],
    ['attributes', hasEntries(project.attributes)],
  ] as const) {
    if (present) field('file.project', project.name, name);
  }

  // Trust zones become trust boundaries, nested as the file nests them.
  const zones = file.trustZones ?? [];
  zones.forEach((zone, index) => {
    const path = `file.trustZones.${index}`;
    const placed = placeBoundary(placementOf(zone.representations)?.position, placementOf(zone.representations)?.size);
    if (placed.adjusted !== null) addNote(note(path, 'adjusted.layout', zone.name, placed.adjusted));
    content(path, zone.name, zone);
    const rating = zone.risk?.trustRating;
    if (typeof rating === 'number' && rating !== OTM_EXPORT.trustRating) field(path, zone.name, 'trustRating');
    elements.push({
      id: `z:${zone.id}`,
      path,
      type: 'trust_boundary',
      name: nameOf(zone.name, path, 'trust_boundary'),
      properties: {},
      layout: placed.layout,
      parent_boundary_id: hasText(zone.parent?.trustZone) ? `z:${zone.parent.trustZone}` : null,
      source_element_id: null,
      target_element_id: null,
      depth: 0,
    });
  });

  // Components become nodes. One inside another component takes the nearest trust zone above it.
  const components = file.components ?? [];
  const componentById = new Map(components.map((component) => [component.id, component]));
  const zoneOf = (component: Component): { zone: string | null; moved: boolean } => {
    const direct = component.parent?.trustZone;
    if (hasText(direct)) return { zone: `z:${direct}`, moved: false };
    const seen = new Set<string>([component.id]);
    for (let next = component.parent?.component; hasText(next) && !seen.has(next); ) {
      seen.add(next);
      const above = componentById.get(next);
      if (above === undefined) break;
      if (hasText(above.parent?.trustZone)) return { zone: `z:${above.parent.trustZone}`, moved: true };
      next = above.parent?.component;
    }
    return { zone: null, moved: hasText(component.parent?.component) };
  };
  components.forEach((component, index) => {
    const path = `file.components.${index}`;
    const { type, defaulted } = nodeTypeOf(component.type);
    if (defaulted) addNote(note(path, 'mapped.component_type', component.name, 'process'));
    const { zone, moved } = zoneOf(component);
    if (moved) addNote(note(path, 'moved.nearest_zone', component.name));
    const placed = placeNode(placementOf(component.representations)?.position);
    if (placed.adjusted !== null) addNote(note(path, 'adjusted.layout', component.name, placed.adjusted));
    content(path, component.name, component);
    const tags = tagsOf(component.tags, path, component.name);
    elements.push({
      id: `c:${component.id}`,
      path,
      type,
      name: nameOf(component.name, path, type),
      properties: tags.length > 0 ? { tags } : {},
      layout: placed.layout,
      parent_boundary_id: zone,
      source_element_id: null,
      target_element_id: null,
      depth: 0,
    });
  });

  // Data flows between two components become flows. Any other is left out, and its threats move to the model.
  const zoneIds = new Set(zones.map((zone) => zone.id));
  const flows = file.dataflows ?? [];
  const keptFlows = new Map<number, string>();
  flows.forEach((flow, index) => {
    const path = `file.dataflows.${index}`;
    for (const [fieldName, end] of [['source', flow.source], ['destination', flow.destination]] as const) {
      if (!componentById.has(end) && !zoneIds.has(end)) throw refuse(`${path}.${fieldName}: must refer to a component in this file`);
    }
    content(path, flow.name, flow);
    if (flow.bidirectional === true) field(path, flow.name, 'bidirectional');
    if (!componentById.has(flow.source) || !componentById.has(flow.destination) || flow.source === flow.destination) {
      addNote(note(path, 'not_imported.dangling_flow', flow.name));
      return;
    }
    const tags = tagsOf(flow.tags, path, flow.name);
    keptFlows.set(index, `f:${flow.id}`);
    elements.push({
      id: `f:${flow.id}`,
      path,
      type: 'data_flow',
      name: nameOf(flow.name, path, 'data_flow'),
      properties: tags.length > 0 ? { tags } : {},
      layout: null,
      parent_boundary_id: null,
      source_element_id: `c:${flow.source}`,
      target_element_id: `c:${flow.destination}`,
      depth: 0,
    });
  });

  // Threats and mitigations. Each reference to a threat is a threat of its own, on the element that refers to it.
  const threatList = file.threats ?? [];
  const mitigationList = file.mitigations ?? [];
  const threatById = new Map<string, { threat: OtmThreat; index: number }>();
  threatList.forEach((threat, index) => {
    if (threatById.has(threat.id)) throw refuse(`file.threats.${index}.id: must be different from every other id in the file`);
    threatById.set(threat.id, { threat, index });
  });
  const mitigationById = new Map<string, { mitigation: OtmMitigation; index: number }>();
  mitigationList.forEach((mitigation, index) => {
    if (mitigationById.has(mitigation.id)) throw refuse(`file.mitigations.${index}.id: must be different from every other id in the file`);
    mitigationById.set(mitigation.id, { mitigation, index });
  });

  const info = new Map<string, ThreatInfo>();
  const infoOf = (threat: OtmThreat, index: number): ThreatInfo => {
    const known = info.get(threat.id);
    if (known !== undefined) return known;
    const path = `file.threats.${index}`;
    const category = (threat.categories ?? []).reduce<StrideCategory | null>((found, candidate) => found ?? (typeof candidate === 'string' ? matchStride(candidate) : null), null);
    const bucket = (raw: number | null | undefined): Impact => {
      if (raw === null || raw === undefined) {
        addNote(note(path, 'mapped.severity', threat.name, 'null'));
        return 'Medium';
      }
      if (raw < 0 || raw > 100) addNote(note(path, 'mapped.risk_clamped', threat.name));
      return level(Math.min(100, Math.max(0, raw)));
    };
    const title = nameOf(threat.name, path, 'threat');
    const made: ThreatInfo = {
      category,
      title,
      description: longText(threat.description ?? '', path, threat.name, 'description'),
      likelihood: bucket(threat.risk?.likelihood),
      impact: bucket(threat.risk?.impact),
    };
    if (category === null) addNote(note(path, 'not_imported.threat_category', threat.name));
    // A threat has one STRIDE category in Scrylux. Any other category it carries is content that has no place, and is listed.
    if ((threat.categories ?? []).filter(hasText).length > 1) field(path, threat.name, 'categories');
    if ((threat.cwes ?? []).length > 0) field(path, threat.name, 'cwes');
    if ((threat.tags ?? []).length > 0) field(path, threat.name, 'tags');
    if (hasText(threat.risk?.likelihoodComment)) field(path, threat.name, 'likelihoodComment');
    if (hasText(threat.risk?.impactComment)) field(path, threat.name, 'impactComment');
    if (hasEntries(threat.attributes)) field(path, threat.name, 'attributes');
    info.set(threat.id, made);
    return made;
  };

  const usedMitigations = new Set<string>();
  let serial = 0;
  const addThreat = (elementId: string | null, reference: Reference, referencePath: string, moved: boolean): void => {
    if (reference === null) return;
    const found = threatById.get(reference.threat);
    if (found === undefined) throw refuse(`${referencePath}.threat: must refer to a threat in this file`);
    const made = infoOf(found.threat, found.index);
    if (made.category === null) return;
    const status: ThreatStatus = statusFrom(OTM_THREAT_STATES, reference.state) ?? 'open';
    if (hasText(reference.state) && statusFrom(OTM_THREAT_STATES, reference.state) === null) {
      addNote(note(referencePath, 'mapped.status', found.threat.name, 'other'));
    }
    if (moved) addNote(note(referencePath, 'moved.model_level', found.threat.name));
    const threatId = `t:${found.threat.id}#${(serial += 1)}`;
    threats.push({
      id: threatId,
      path: `file.threats.${found.index}`,
      element_id: elementId,
      category: made.category,
      title: made.title,
      description: made.description,
      likelihood: made.likelihood,
      impact: made.impact,
      status,
      status_reason: null,
      origin: 'manual',
      library_ref: null,
      stale: null,
    });
    (reference.mitigations ?? []).forEach((attached, position) => {
      if (attached === null || !hasText(attached.mitigation)) return;
      const mitigationPath = `${referencePath}.mitigations.${position}`;
      const target = mitigationById.get(attached.mitigation);
      if (target === undefined) throw refuse(`${mitigationPath}.mitigation: must refer to a mitigation in this file`);
      const { mitigation, index } = target;
      const own: MitigationStatus | null = statusFrom(OTM_MITIGATION_STATES, attached.state);
      if (hasText(attached.state) && own === null) addNote(note(mitigationPath, 'mapped.status', mitigation.name, 'other'));
      const name = mitigation.name.trim();
      const description = (mitigation.description ?? '').trim();
      const body = description === '' ? name : description.startsWith(name) ? description : `${name}\n\n${description}`;
      usedMitigations.add(mitigation.id);
      mitigations.push({
        id: `m:${mitigation.id}#${(serial += 1)}`,
        path: `file.mitigations.${index}`,
        threat_id: threatId,
        description: longText(body === '' ? nameOf('', `file.mitigations.${index}`, 'mitigation') : body, `file.mitigations.${index}`, mitigation.name, 'description'),
        status: own ?? 'proposed',
        external_ref: null,
      });
    });
  };

  const referenced = new Set<string>();
  const handle = (owner: { threats?: readonly Reference[] | null }, elementId: string | null, path: string, moved: boolean): void => {
    (owner.threats ?? []).forEach((reference, position) => {
      if (reference !== null) referenced.add(reference.threat);
      addThreat(elementId, reference, `${path}.threats.${position}`, moved);
    });
  };
  components.forEach((component, index) => handle(component, `c:${component.id}`, `file.components.${index}`, false));
  flows.forEach((flow, index) => handle(flow, keptFlows.get(index) ?? null, `file.dataflows.${index}`, !keptFlows.has(index)));

  // A threat nothing refers to is a threat of the model, open.
  threatList.forEach((threat, index) => {
    if (referenced.has(threat.id)) return;
    addThreat(null, { threat: threat.id, state: null, mitigations: null }, `file.threats.${index}`, false);
  });

  mitigationList.forEach((mitigation, index) => {
    const path = `file.mitigations.${index}`;
    if (typeof mitigation.riskReduction === 'number' && mitigation.riskReduction !== OTM_EXPORT.riskReduction) field(path, mitigation.name, 'riskReduction');
    if (hasEntries(mitigation.attributes)) field(path, mitigation.name, 'attributes');
    if (!usedMitigations.has(mitigation.id)) field(path, mitigation.name, 'unreferencedMitigation');
  });

  return {
    models: [
      {
        threatModel: { id: 'model', name: project.name, methodology: 'STRIDE', status: 'draft' },
        name_issue: null,
        elements,
        threats,
        mitigations,
      },
    ],
    notes,
  };
}
