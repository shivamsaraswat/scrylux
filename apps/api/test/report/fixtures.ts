import {
  deriveRisk,
  type ElementRecord,
  type ElementType,
  type Impact,
  type Likelihood,
  type MitigationRecord,
  type MitigationStatus,
  type StaleReason,
  type ThreatOrigin,
  type ThreatRecord,
  type ThreatStatus,
  type StrideCategory,
} from '@scrylux/core';
import type { Snapshot } from '../../src/snapshot.js';

// Snapshots for the report tests: plain records that parse with core's record schemas (data-model.md §1).

const MODEL_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const at = (second = 0): string => `2026-10-07T10:00:${String(second).padStart(2, '0')}.000Z`;
const uid = (prefix: string, n: number): string => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const elementId = (n: number): string => uid('e', n);
export const threatId = (n: number): string => uid('a', n);
export const mitigationId = (n: number): string => uid('b', n);

export function element(n: number, overrides: Partial<ElementRecord> & { type?: ElementType } = {}): ElementRecord {
  return {
    id: elementId(n),
    threat_model_id: MODEL_ID,
    type: 'process',
    name: `Element ${n}`,
    properties: {},
    layout: { x: 0, y: 0 },
    source_element_id: null,
    target_element_id: null,
    parent_boundary_id: null,
    created_at: at(n % 60),
    updated_at: at(n % 60),
    ...overrides,
  };
}

export function threat(
  n: number,
  overrides: Partial<Omit<ThreatRecord, 'risk'>> & { likelihood?: Likelihood; impact?: Impact } = {},
): ThreatRecord {
  const likelihood = overrides.likelihood ?? 'Medium';
  const impact = overrides.impact ?? 'Medium';
  return {
    id: threatId(n),
    threat_model_id: MODEL_ID,
    element_id: null,
    category: 'Spoofing',
    title: `Threat ${n}`,
    description: `Description ${n}`,
    likelihood,
    impact,
    risk: deriveRisk(likelihood, impact),
    status: 'open',
    origin: 'manual',
    library_ref: null,
    stale: null,
    status_reason: null,
    created_at: at(n % 60),
    updated_at: at(n % 60),
    ...overrides,
  };
}

export function mitigation(n: number, threatN: number, overrides: Partial<MitigationRecord> = {}): MitigationRecord {
  return {
    id: mitigationId(n),
    threat_id: threatId(threatN),
    description: `Mitigation ${n}`,
    status: 'proposed',
    external_ref: null,
    created_at: at(n % 60),
    updated_at: at(n % 60),
    ...overrides,
  };
}

function snapshot(parts: Partial<Snapshot> = {}): Snapshot {
  return {
    model: {
      id: MODEL_ID,
      project_id: PROJECT_ID,
      name: 'Payments API',
      methodology: 'STRIDE',
      status: 'in_review',
      created_at: at(0),
      updated_at: at(0),
    },
    project: { name: 'Checkout' },
    elements: [],
    threats: [],
    mitigations: [],
    ...parts,
  };
}

export const EXPORTED_AT = new Date('2026-10-10T14:03:30Z');

export const LONG_TOKEN = 'x'.repeat(300);

// The ids of `typical()`'s records, by what they are.
export const T = {
  inner: elementId(1),
  dbZone: elementId(2),
  api: elementId(3),
  db: elementId(4),
  browser: elementId(5),
  https: elementId(6),
  sql: elementId(7),
  worker: elementId(8),
  jobs: elementId(9),
} as const;

// A threat model with nested boundaries, flows that do and do not cross a boundary, every threat status, a stale
// threat, both lifecycle gaps, an AI-origin threat, a 300-character token, and model-level threats.
export function typical(): Snapshot {
  const elements: ElementRecord[] = [
    element(1, { type: 'trust_boundary', name: 'Internal network', layout: { x: 0, y: 0, width: 600, height: 400 } }),
    element(2, {
      type: 'trust_boundary',
      name: 'DB zone',
      parent_boundary_id: T.inner,
      layout: { x: 300, y: 80, width: 260, height: 200 },
    }),
    element(3, {
      name: 'API',
      parent_boundary_id: T.inner,
      layout: { x: 20, y: 60 },
      properties: {
        tags: ['Node.js', 'Express'],
        flags: { internet_facing: true, requires_authentication: true, runs_privileged: false },
      },
    }),
    element(4, {
      type: 'data_store',
      name: 'Orders DB',
      parent_boundary_id: T.dbZone,
      layout: { x: 20, y: 40 },
      properties: { tags: ['PostgreSQL'], flags: { stores_sensitive_data: true } },
    }),
    element(5, { type: 'external_entity', name: 'Browser', layout: { x: -300, y: 100 } }),
    element(6, {
      type: 'data_flow',
      name: 'HTTPS request',
      layout: null,
      source_element_id: T.browser,
      target_element_id: T.api,
      properties: { flags: { encrypted_in_transit: true } },
    }),
    element(7, { type: 'data_flow', name: 'SQL', layout: null, source_element_id: T.api, target_element_id: T.db }),
    element(8, { name: 'Worker', parent_boundary_id: T.inner, layout: { x: 20, y: 200 } }),
    element(9, { type: 'data_flow', name: 'Jobs', layout: null, source_element_id: T.api, target_element_id: T.worker }),
  ];
  const staleUnknown: StaleReason = { reason: 'rule_unknown' };
  const threats: ThreatRecord[] = [
    threat(1, {
      element_id: T.api,
      title: 'Session token replay',
      category: 'Spoofing',
      likelihood: 'High',
      impact: 'Medium',
      status: 'accepted',
      status_reason: 'Tokens expire after 5 minutes; residual risk accepted by the platform team.',
      origin: 'rule',
      library_ref: 'spoofing.session-replay',
    }),
    threat(2, { element_id: T.api, title: 'Request tampering', category: 'Tampering', likelihood: 'High', impact: 'High' }),
    threat(3, {
      element_id: T.api,
      title: 'Stale rule threat',
      category: 'Repudiation',
      origin: 'rule',
      library_ref: 'repudiation.gone',
      stale: staleUnknown,
    }),
    threat(4, { element_id: T.db, title: 'Disk theft', category: 'Information Disclosure', status: 'mitigated' }),
    threat(5, { element_id: T.browser, title: 'Browser spoofing', likelihood: 'Low', impact: 'Low' }),
    threat(6, { element_id: T.inner, title: 'Boundary privilege escalation', category: 'Elevation of Privilege' }),
    threat(7, { element_id: T.sql, title: 'Query tampering', category: 'Tampering' }),
    threat(8, {
      element_id: T.https,
      title: 'Eavesdropping',
      category: 'Information Disclosure',
      status: 'not_applicable',
      status_reason: 'The flow stays on a private link.',
    }),
    threat(9, { title: 'Provider outage', category: 'Denial of Service' }),
    threat(10, { title: 'Unattributed decisions', category: 'Repudiation', status: 'accepted', status_reason: null }),
    threat(11, { element_id: T.worker, title: 'Queue flooding', category: 'Denial of Service', status: 'mitigated' }),
    threat(12, { element_id: T.db, title: 'AI-found tampering', category: 'Tampering', origin: 'ai' }),
    threat(13, { element_id: T.worker, title: 'Long token', description: LONG_TOKEN, category: 'Denial of Service' }),
  ];
  const mitigations: MitigationRecord[] = [
    mitigation(1, 4, { description: 'Encrypt the volume', status: 'implemented', external_ref: 'https://tracker.example/SEC-12' }),
    mitigation(2, 1, { description: 'Rotate signing keys', status: 'proposed', external_ref: 'JIRA-7' }),
    mitigation(3, 11, { description: 'Add a queue limit', status: 'proposed' }),
    mitigation(4, 1, { description: 'Bind tokens to the session', status: 'implemented', external_ref: 'https://tracker.example/SEC-13' }),
    mitigation(5, 2, { description: 'Validate every field', status: 'verified' }),
  ];
  return snapshot({ elements, threats, mitigations });
}

// Three nodes with no saved position, created in an order that differs from their ids.
export function unplaced(): Snapshot {
  return snapshot({
    elements: [
      element(3, { name: 'Third by id, first created', layout: null, created_at: at(1) }),
      element(1, { name: 'First by id, last created', layout: null, created_at: at(9) }),
      element(2, { name: 'Second by id, second created', type: 'data_store', layout: null, created_at: at(5) }),
    ],
  });
}

export function duplicateNames(): Snapshot {
  return snapshot({
    elements: [element(1, { name: 'Worker' }), element(2, { name: 'Worker', layout: { x: 200, y: 0 } }), element(3, { name: 'Unique' })],
    threats: [threat(1, { element_id: elementId(1), title: 'First worker threat' }), threat(2, { element_id: elementId(2), title: 'Second worker threat' })],
  });
}

export function empty(): Snapshot {
  return snapshot();
}

// Every kind of Markdown, HTML and Mermaid syntax, one string each, none longer than a tag may be. contracts/report-format.md
// "Escaping fixtures".
export const HOSTILE = [
  '# Heading?',
  'a | pipe | b |',
  '*emphasis* _under_ ~~strike~~',
  '[link](https://evil.example)',
  '![img](https://evil.example/x.png)',
  '<https://evil.example>',
  'https://evil.example',
  'www.evil.example',
  'user@evil.example',
  '<script>window.__ran = 1</script>',
  '<img src=x onerror="window.__ran=1">',
  '<b>bold</b>',
  '`code` ```fence```',
  '--> end subgraph',
  `"quotes" 'single'`,
  '#35; &amp; &lt;',
  '\\backslash\\',
  '1. not a list',
  '- not a list',
  '> not a quote',
  '    four leading spaces',
  'javascript:alert(1)',
] as const;

export const HOSTILE_MULTILINE = 'line one\nline two\n\nparagraph after a blank line';

export const HOSTILE_TICKETS = [
  'https://evil.example/a_b*c?x=1&y=<2>',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'JIRA-7 <b>x</b>',
] as const;

// One process per hostile string, each with the string as its name and tag, and a threat and a mitigation that carry it
// in every text field. Also a boundary and a flow with hostile names, and hostile model and project names.
export function hostile(): Snapshot {
  const n = HOSTILE.length;
  const boundary = element(1, { type: 'trust_boundary', name: '<b>boundary</b> "q"', layout: { x: 0, y: 0, width: 400, height: 300 } });
  const elements: ElementRecord[] = [boundary];
  const threats: ThreatRecord[] = [];
  const mitigations: MitigationRecord[] = [];
  HOSTILE.forEach((text, i) => {
    const k = i + 2;
    elements.push(
      element(k, {
        name: text,
        parent_boundary_id: i % 2 === 0 ? boundary.id : null,
        layout: { x: 10 + (i % 4) * 150, y: 40 + Math.floor(i / 4) * 70 },
        properties: { tags: [text] },
      }),
    );
    const statuses: ThreatStatus[] = ['accepted', 'not_applicable'];
    threats.push(
      threat(i + 1, {
        element_id: elementId(k),
        title: text,
        description: `${text}\n${HOSTILE_MULTILINE}`,
        status: statuses[i % 2] as ThreatStatus,
        status_reason: `${text}\n${HOSTILE_MULTILINE}`,
        category: 'Tampering' satisfies StrideCategory,
        origin: ['manual', 'rule', 'ai'][i % 3] as ThreatOrigin,
      }),
    );
    mitigations.push(
      mitigation(i + 1, i + 1, {
        description: text,
        status: (['proposed', 'implemented', 'verified'] as MitigationStatus[])[i % 3] as MitigationStatus,
        external_ref: HOSTILE_TICKETS[i % HOSTILE_TICKETS.length] as string,
      }),
    );
  });
  elements.push(
    element(n + 2, {
      type: 'data_flow',
      name: HOSTILE[9],
      layout: null,
      source_element_id: elementId(2),
      target_element_id: elementId(3),
    }),
  );
  return snapshot({
    model: { ...snapshot().model, name: HOSTILE[11] },
    project: { name: HOSTILE[3] },
    elements,
    threats,
    mitigations,
  });
}

// A deterministic shuffle: the same records in a different array order (Fisher-Yates over a small LCG).
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function shuffled(source: Snapshot, seed: number): Snapshot {
  return {
    ...source,
    elements: shuffle(source.elements, seed),
    threats: shuffle(source.threats, seed + 1),
    mitigations: shuffle(source.mitigations, seed + 2),
  };
}

// `typical()` with a unique alphanumeric marker (`Tmk0001`...) in every element name, threat title and mitigation
// description. They have no punctuation, so Markdown escaping leaves them whole.
export function withMarkers(): Snapshot {
  const source = typical();
  let count = 0;
  const marker = (): string => `Tmk${String(++count).padStart(4, '0')}`;
  return {
    ...source,
    elements: source.elements.map((e) => ({ ...e, name: `${e.name} ${marker()}` })),
    threats: source.threats.map((t) => ({ ...t, title: `${t.title} ${marker()}` })),
    mitigations: source.mitigations.map((m) => ({ ...m, description: `${m.description} ${marker()}` })),
  };
}
