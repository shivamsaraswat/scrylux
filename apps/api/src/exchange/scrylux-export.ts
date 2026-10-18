import { SCRYLUX_FORMAT_VERSION, type ElementRecord, type JsonValue, type MitigationRecord, type StaleReason, type ThreatModelRecord, type ThreatRecord } from '@scrylux/core';
import type { Snapshot } from '../snapshot.js';
import { sortElements, sortMitigations, sortThreats } from './order.js';

// The Scrylux file an export writes (contracts/scrylux-file.md). It is built from one snapshot of the threat model, in
// content order, with every key present and in a fixed order, so exporting an unchanged model twice gives bytes that
// differ only in `exported_at` (FR-005). Nothing identifies an account, and nothing stored is dropped: an element kept
// from before today's rules is exported as stored, and the import refuses it by name (spec, edge cases).

type Json = Record<string, JsonValue>;

export interface ExportedElement {
  id: string;
  type: ElementRecord['type'];
  name: string;
  properties: Json;
  layout: Json | null;
  parent_boundary_id: string | null;
  source_element_id: string | null;
  target_element_id: string | null;
}

export interface ExportedThreat {
  id: string;
  element_id: string | null;
  category: ThreatRecord['category'];
  title: string;
  description: string;
  likelihood: ThreatRecord['likelihood'];
  impact: ThreatRecord['impact'];
  status: ThreatRecord['status'];
  status_reason: string | null;
  origin: ThreatRecord['origin'];
  library_ref: string | null;
  stale: StaleReason | null;
}

export interface ExportedMitigation {
  id: string;
  threat_id: string;
  description: string;
  status: MitigationRecord['status'];
  external_ref: string | null;
}

export interface ExportedFile {
  format: 'scrylux';
  format_version: typeof SCRYLUX_FORMAT_VERSION;
  exported_at: string;
  project: { name: string };
  threat_model: { name: string; methodology: ThreatModelRecord['methodology']; status: ThreatModelRecord['status'] };
  elements: ExportedElement[];
  threats: ExportedThreat[];
  mitigations: ExportedMitigation[];
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The keys of `value` with `first` leading, then the rest by code point.
function orderKeys(value: Json, first: readonly string[]): Json {
  const out: Json = {};
  for (const key of first) if (Object.hasOwn(value, key)) out[key] = value[key] as JsonValue;
  for (const key of Object.keys(value).sort(byCodePoint)) if (!Object.hasOwn(out, key)) out[key] = value[key] as JsonValue;
  return out;
}

// Tags and flags that say nothing are left out, so an empty list and a missing one export the same bytes.
function exportedProperties(stored: Json): Json {
  const { tags, flags, ...rest } = stored;
  const out: Json = {};
  if (tags !== undefined && !(Array.isArray(tags) && tags.length === 0)) out.tags = tags;
  if (flags !== undefined) {
    const isEmpty = typeof flags === 'object' && flags !== null && !Array.isArray(flags) && Object.keys(flags).length === 0;
    if (!isEmpty) out.flags = typeof flags === 'object' && flags !== null && !Array.isArray(flags) ? orderKeys(flags, []) : flags;
  }
  return { ...out, ...orderKeys(rest, []) };
}

export function buildScryluxFile(snapshot: Snapshot, exportedAt: Date): ExportedFile {
  const elements = sortElements(snapshot.elements);
  const threats = sortThreats(snapshot.threats, elements.position);
  const mitigations = sortMitigations(snapshot.mitigations, threats.position);
  return {
    format: 'scrylux',
    format_version: SCRYLUX_FORMAT_VERSION,
    exported_at: exportedAt.toISOString(),
    project: { name: snapshot.project.name },
    threat_model: { name: snapshot.model.name, methodology: snapshot.model.methodology, status: snapshot.model.status },
    elements: elements.sorted.map((element) => ({
      id: element.id,
      type: element.type,
      name: element.name,
      properties: exportedProperties(element.properties),
      layout: element.layout === null ? null : orderKeys(element.layout, ['x', 'y', 'width', 'height']),
      parent_boundary_id: element.parent_boundary_id,
      source_element_id: element.source_element_id,
      target_element_id: element.target_element_id,
    })),
    threats: threats.sorted.map((threat) => ({
      id: threat.id,
      element_id: threat.element_id,
      category: threat.category,
      title: threat.title,
      description: threat.description,
      likelihood: threat.likelihood,
      impact: threat.impact,
      status: threat.status,
      status_reason: threat.status_reason,
      origin: threat.origin,
      library_ref: threat.library_ref,
      stale: threat.stale,
    })),
    mitigations: mitigations.map((mitigation) => ({
      id: mitigation.id,
      threat_id: mitigation.threat_id,
      description: mitigation.description,
      status: mitigation.status,
      external_ref: mitigation.external_ref,
    })),
  };
}

// Two-space indentation, \n line endings and one final newline, so the file diffs line by line.
export function serializeExport(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
