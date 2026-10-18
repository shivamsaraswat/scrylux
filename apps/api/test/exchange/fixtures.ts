import {
  deriveRisk,
  type ElementRecord,
  type ElementType,
  type Impact,
  type Likelihood,
  type Methodology,
  type MitigationRecord,
  type MitigationStatus,
  type StaleReason,
  type StrideCategory,
  type ThreatModelStatus,
  type ThreatOrigin,
  type ThreatRecord,
  type ThreatStatus,
} from '@scrylux/core';
import type { Snapshot } from '../../src/snapshot.js';

// Builders the exchange suites share. Each returns a Scrylux file in the shape of contracts/scrylux-file.md, built by
// hand, so a test can change one field and see which rule refuses it. Ids are readable strings: in a file they are
// opaque, and an import replaces them.

export interface FileElement {
  id: string;
  type: ElementType;
  name: string;
  properties: { tags?: string[]; flags?: Record<string, boolean> };
  layout: { x: number; y: number; width?: number; height?: number } | null;
  parent_boundary_id: string | null;
  source_element_id: string | null;
  target_element_id: string | null;
}

export interface FileThreat {
  id: string;
  element_id: string | null;
  category: StrideCategory;
  title: string;
  description: string;
  likelihood: Likelihood;
  impact: Impact;
  status: ThreatStatus;
  status_reason: string | null;
  origin: ThreatOrigin;
  library_ref: string | null;
  stale: StaleReason | null;
}

export interface FileMitigation {
  id: string;
  threat_id: string;
  description: string;
  status: MitigationStatus;
  external_ref: string | null;
}

export interface ExchangeFile {
  format: 'scrylux';
  format_version: 1;
  exported_at: string;
  project: { name: string };
  threat_model: { name: string; methodology: Methodology; status: ThreatModelStatus };
  elements: FileElement[];
  threats: FileThreat[];
  mitigations: FileMitigation[];
}

const node = (id: string, type: ElementType, name: string, extra: Partial<FileElement> = {}): FileElement => ({
  id,
  type,
  name,
  properties: {},
  layout: null,
  parent_boundary_id: null,
  source_element_id: null,
  target_element_id: null,
  ...extra,
});

const threat = (id: string, element_id: string | null, category: StrideCategory, title: string, extra: Partial<FileThreat> = {}): FileThreat => ({
  id,
  element_id,
  category,
  title,
  description: `${title}: description`,
  likelihood: 'Medium',
  impact: 'High',
  status: 'open',
  status_reason: null,
  origin: 'manual',
  library_ref: null,
  stale: null,
  ...extra,
});

const mitigation = (id: string, threat_id: string, description: string, status: MitigationStatus, external_ref: string | null = null): FileMitigation => ({
  id,
  threat_id,
  description,
  status,
  external_ref,
});

// The threat model of spec US1's Independent Test: nested trust boundaries, nodes inside and outside them, one that
// was never placed, flows (one crossing a boundary), tags and flags set to yes, no and left unassessed, generated
// threats (one stale), manual threats in every status, including the two a user could not create (accepted with no
// reason, and mitigated with no implemented mitigation), threats on a boundary and on no element, and mitigations with
// and without a ticket.
export function us1Model(): ExchangeFile {
  return {
    format: 'scrylux',
    format_version: 1,
    exported_at: '2026-10-10T09:30:00.000Z',
    project: { name: 'Payments' },
    threat_model: { name: 'Checkout', methodology: 'STRIDE', status: 'in_review' },
    elements: [
      node('b-internal', 'trust_boundary', 'Internal network', { layout: { x: 40, y: 40, width: 700, height: 420 } }),
      node('b-db', 'trust_boundary', 'DB zone', { layout: { x: 400, y: 120, width: 260, height: 240 }, parent_boundary_id: 'b-internal' }),
      node('e-browser', 'external_entity', 'Browser', {
        properties: { flags: { authenticated: true, internet_facing: true } },
        layout: { x: -260, y: 160 },
      }),
      node('p-api', 'process', 'API', {
        properties: { tags: ['Node.js', 'Express'], flags: { internet_facing: true, requires_authentication: true, handles_sensitive_data: false } },
        layout: { x: 60, y: 120 },
        parent_boundary_id: 'b-internal',
      }),
      node('d-orders', 'data_store', 'Orders DB', {
        properties: { flags: { stores_sensitive_data: true, encrypted_at_rest: false } },
        layout: { x: 60, y: 80 },
        parent_boundary_id: 'b-db',
      }),
      node('p-batch', 'process', 'Batch'),
      node('f-https', 'data_flow', 'HTTPS request', {
        properties: { tags: ['HTTPS'], flags: { encrypted_in_transit: true, authenticated: true } },
        source_element_id: 'e-browser',
        target_element_id: 'p-api',
      }),
      node('f-sql', 'data_flow', 'SQL', {
        properties: { flags: { encrypted_in_transit: false } },
        source_element_id: 'p-api',
        target_element_id: 'd-orders',
      }),
    ],
    threats: [
      threat('t-rule-1', 'p-api', 'Spoofing', 'Spoofing of API', { origin: 'rule', library_ref: 'process-spoofing', description: 'An attacker pretends to be the API.' }),
      threat('t-rule-2', 'd-orders', 'Information Disclosure', 'Orders DB is readable at rest', {
        origin: 'rule',
        library_ref: 'store-unencrypted',
        stale: { reason: 'rule_unknown' },
      }),
      threat('t-rule-3', 'f-https', 'Tampering', 'Request tampered in transit', { origin: 'rule', library_ref: 'flow-tamper', likelihood: 'Low', impact: 'Low' }),
      threat('t-man-acc', 'p-api', 'Repudiation', 'No audit trail', { status: 'accepted', status_reason: 'Risk accepted by the owner', likelihood: 'High' }),
      threat('t-man-na', 'd-orders', 'Denial of Service', 'Disk fills up', { status: 'not_applicable', status_reason: 'Out of scope for this release' }),
      threat('t-man-acc-noreason', 'f-sql', 'Elevation of Privilege', 'Over-privileged DB account', { status: 'accepted' }),
      threat('t-man-mit-gap', 'p-batch', 'Tampering', 'Batch input is not checked', { status: 'mitigated' }),
      threat('t-boundary', 'b-internal', 'Spoofing', 'A host in the network is spoofed'),
      threat('t-model-1', null, 'Information Disclosure', 'Backups leave the network', { description: '' }),
      threat('t-model-2', null, 'Denial of Service', 'Provider outage', { likelihood: 'Low' }),
    ],
    mitigations: [
      mitigation('m-1', 't-rule-1', 'Require MFA', 'implemented', 'https://tracker.example/SEC-1'),
      mitigation('m-2', 't-rule-1', 'Rate-limit sign-in', 'proposed'),
      mitigation('m-3', 't-man-mit-gap', 'Add a checksum', 'proposed'),
      mitigation('m-4', 't-man-acc', 'Add an audit log', 'verified'),
    ],
  };
}

// Every kind of Markdown, HTML and Mermaid syntax, one string each. Copied from WEB/e2e/hostile.ts, which a test in
// another package cannot import.
export const HOSTILE = [
  '# Heading?',
  'a | pipe | b |',
  '*emphasis* _under_ ~~strike~~',
  '[link](https://evil.example)',
  '![img](https://evil.example/x.png)',
  '<script>window.__ran = 1</script>',
  '<img src=x onerror="window.__ran=1">',
  '`code` ```fence```',
  '--> end subgraph',
  `"quotes" 'single'`,
  '#35; &amp; &lt;',
  '\\backslash\\',
  'javascript:alert(1)',
] as const;
export const HOSTILE_MULTILINE = 'line one\nline two\n\nparagraph after a blank line';
export const HOSTILE_TICKET = 'https://evil.example/a_b*c?x=1&y=<2>';
export const BOUNDARY_NAME = '<b>boundary</b> "q"';
export const FLOW_NAME = '<i>flow</i> & "x" [y](z)';
export const MODEL_NAME = '<b>bold</b> | model # 1';

// us1Model with every free-text field replaced by hostile text. Names stay unique so their records stay apart.
export function hostile(): ExchangeFile {
  const file = us1Model();
  file.threat_model.name = MODEL_NAME;
  file.project.name = HOSTILE[3];
  const pick = (index: number): string => `${HOSTILE[index % HOSTILE.length] as string} ${index}`;
  file.elements.forEach((item, index) => {
    item.name = item.type === 'trust_boundary' ? `${BOUNDARY_NAME} ${index}` : item.type === 'data_flow' ? `${FLOW_NAME} ${index}` : pick(index);
    if (item.properties.tags) item.properties.tags = item.properties.tags.map((_tag, tagIndex) => `tag ${HOSTILE[(index + tagIndex) % 4] as string}`.slice(0, 50));
  });
  file.threats.forEach((item, index) => {
    item.title = pick(index);
    item.description = HOSTILE_MULTILINE;
    if (item.status_reason !== null) item.status_reason = HOSTILE_MULTILINE;
  });
  file.mitigations.forEach((item, index) => {
    item.description = pick(index + 3);
    if (item.external_ref !== null) item.external_ref = HOSTILE_TICKET;
  });
  return file;
}

// The request body of the check and import operations for a Scrylux file.
export function scryluxBody(file: ExchangeFile, names?: string[]): { format: 'scrylux'; names?: string[]; file: ExchangeFile } {
  return names === undefined ? { format: 'scrylux', file } : { format: 'scrylux', names, file };
}

// The same file with every id replaced through `map`, and every reference with it.
export function withIds(file: ExchangeFile, map: (id: string) => string): ExchangeFile {
  const nullable = (id: string | null): string | null => (id === null ? null : map(id));
  return {
    ...file,
    elements: file.elements.map((item) => ({
      ...item,
      id: map(item.id),
      parent_boundary_id: nullable(item.parent_boundary_id),
      source_element_id: nullable(item.source_element_id),
      target_element_id: nullable(item.target_element_id),
    })),
    threats: file.threats.map((item) => ({ ...item, id: map(item.id), element_id: nullable(item.element_id) })),
    mitigations: file.mitigations.map((item) => ({ ...item, id: map(item.id), threat_id: map(item.threat_id) })),
  };
}

// What FR-004 compares: the file without its export time, and with every id replaced by its record's place in the
// file (e0, t0, m0...), so two files are equal exactly when they are equal once ids are mapped. Files in content order
// (an export) have corresponding records in corresponding places.
export function canonical(file: ExchangeFile): unknown {
  const labels = new Map<string, string>();
  file.elements.forEach((item, index) => labels.set(item.id, `e${index}`));
  file.threats.forEach((item, index) => labels.set(item.id, `t${index}`));
  file.mitigations.forEach((item, index) => labels.set(item.id, `m${index}`));
  const mapped = withIds(file, (id) => labels.get(id) ?? id);
  return { format: mapped.format, format_version: mapped.format_version, threat_model: mapped.threat_model, elements: mapped.elements, threats: mapped.threats, mitigations: mapped.mitigations };
}

const MODEL_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const STORED_AT = '2026-10-07T10:00:00.000Z';

// A file as the snapshot an export reads: records with their storage-only columns. Ids stay as the file has them, and
// every row has the same created_at, as the rows of one import do.
export function snapshotOf(file: ExchangeFile): Snapshot {
  const timestamps = { created_at: STORED_AT, updated_at: STORED_AT };
  const elements: ElementRecord[] = file.elements.map((item) => ({ ...item, ...timestamps, threat_model_id: MODEL_ID }));
  const threats: ThreatRecord[] = file.threats.map((item) => ({
    ...item,
    ...timestamps,
    threat_model_id: MODEL_ID,
    risk: deriveRisk(item.likelihood, item.impact),
  }));
  const mitigations: MitigationRecord[] = file.mitigations.map((item) => ({ ...item, ...timestamps }));
  return {
    model: { id: MODEL_ID, project_id: PROJECT_ID, ...file.threat_model, ...timestamps },
    project: { name: file.project.name },
    elements,
    threats,
    mitigations,
  };
}
