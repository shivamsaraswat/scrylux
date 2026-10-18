import { ELEMENT_FLAGS } from '@scrylux/core';
import { shippedLibrary } from '@scrylux/threat-library';
import db from '../../../src/db.js';
import { uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// The threat model of spec US1's Independent Test, built the way a user builds it (research #20, T027): the diagram
// through the API, rule-generated threats by running generation, manual threats through the API, and, with direct SQL
// as storage-errors.test.ts does for what the API refuses, a stale rule threat, an accepted threat with no reason and a
// mitigated threat with no implemented mitigation. Statements are parameterized.

export interface SeededUs1 {
  projectId: string;
  modelId: string;
  modelName: string;
  staleThreatId: string;
  acceptedNoReasonId: string;
  mitigatedGapId: string;
  elementIds: Record<'internal' | 'db' | 'browser' | 'api' | 'orders' | 'batch' | 'https' | 'sql', string>;
}

export async function seedUs1Model(c: V1Client, projectId?: string, modelName = uniqueName('Checkout')): Promise<SeededUs1> {
  const project = projectId ?? ((await c.post<ApiRecord>('/projects', { name: uniqueName('Payments') })).body.id);
  const model = (await c.post<ApiRecord>('/threat-models', { project_id: project, name: modelName, status: 'in_review' })).body;
  const modelId = model.id;

  const element = async (body: Record<string, unknown>): Promise<string> => {
    const res = await c.post<ApiRecord>('/elements', { threat_model_id: modelId, ...body });
    if (res.status !== 201) throw new Error(`could not seed an element: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id;
  };
  const internal = await element({ type: 'trust_boundary', name: 'Internal network', layout: { x: 40, y: 40, width: 700, height: 420 } });
  const dbZone = await element({ type: 'trust_boundary', name: 'DB zone', parent_boundary_id: internal, layout: { x: 400, y: 120, width: 260, height: 240 } });
  const browser = await element({ type: 'external_entity', name: 'Browser', properties: { flags: { authenticated: true, internet_facing: true } }, layout: { x: -260, y: 160 } });
  const api = await element({
    type: 'process',
    name: 'API',
    properties: { tags: ['Node.js', 'Express'], flags: { internet_facing: true, requires_authentication: true, handles_sensitive_data: false } },
    parent_boundary_id: internal,
    layout: { x: 60, y: 120 },
  });
  const orders = await element({
    type: 'data_store',
    name: 'Orders DB',
    properties: { flags: { stores_sensitive_data: true, encrypted_at_rest: false } },
    parent_boundary_id: dbZone,
    layout: { x: 60, y: 80 },
  });
  const batch = await element({ type: 'process', name: 'Batch' });
  const https = await element({
    type: 'data_flow',
    name: 'HTTPS request',
    properties: { tags: ['HTTPS'], flags: { encrypted_in_transit: true, authenticated: true } },
    source_element_id: browser,
    target_element_id: api,
  });
  const sql = await element({ type: 'data_flow', name: 'SQL', properties: { flags: { encrypted_in_transit: false } }, source_element_id: api, target_element_id: orders });

  // The rule threats: whatever the shipped library finds in this diagram.
  const generated = await c.post(`/threat-models/${modelId}/threats/generate`, {});
  if (generated.status !== 200) throw new Error(`generation failed: ${generated.status}`);

  const threat = async (elementId: string | null, category: string, title: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const res = await c.post<ApiRecord>('/threats', {
      threat_model_id: modelId,
      element_id: elementId,
      category,
      title,
      description: `${title}: description`,
      likelihood: 'Medium',
      impact: 'High',
      origin: 'manual',
      ...extra,
    });
    if (res.status !== 201) throw new Error(`could not seed a threat: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id;
  };
  const accepted = await threat(api, 'Repudiation', 'No audit trail', { likelihood: 'High' });
  await c.patch(`/threats/${accepted}`, { status: 'accepted', status_reason: 'Risk accepted by the owner' });
  const notApplicable = await threat(orders, 'Denial of Service', 'Disk fills up');
  await c.patch(`/threats/${notApplicable}`, { status: 'not_applicable', status_reason: 'Out of scope for this release' });
  const acceptedNoReasonId = await threat(sql, 'Elevation of Privilege', 'Over-privileged DB account');
  const mitigatedGapId = await threat(batch, 'Tampering', 'Batch input is not checked');
  await threat(internal, 'Spoofing', 'A host in the network is spoofed');
  await threat(null, 'Information Disclosure', 'Backups leave the network', { description: '' });
  await threat(null, 'Denial of Service', 'Provider outage', { likelihood: 'Low' });

  await c.post('/mitigations', { threat_id: accepted, description: 'Add an audit log', status: 'verified' });
  await c.post('/mitigations', { threat_id: accepted, description: 'Review quarterly', status: 'proposed', external_ref: 'https://tracker.example/SEC-1' });
  await c.post('/mitigations', { threat_id: mitigatedGapId, description: 'Add a checksum', status: 'proposed' });

  // The states Milestone 4's rules refuse to create (FR-009): set in storage, as an old or imported model would hold them.
  await db.query(`UPDATE threats SET status = 'accepted', status_reason = NULL WHERE id = $1`, [acceptedNoReasonId]);
  await db.query(`UPDATE threats SET status = 'mitigated' WHERE id = $1`, [mitigatedGapId]);
  const rule = await db.query<{ id: string }>(`SELECT id FROM threats WHERE threat_model_id = $1 AND origin = 'rule' ORDER BY id LIMIT 1`, [modelId]);
  const staleThreatId = rule.rows[0]?.id;
  if (staleThreatId === undefined) throw new Error('generation produced no rule threat');
  await db.query(`UPDATE threats SET stale = $2::jsonb WHERE id = $1 AND origin = 'rule'`, [staleThreatId, JSON.stringify({ reason: 'rule_unknown' })]);

  return {
    projectId: project,
    modelId,
    modelName,
    staleThreatId,
    acceptedNoReasonId,
    mitigatedGapId,
    elementIds: { internal, db: dbZone, browser, api, orders, batch, https, sql },
  };
}

// ---- the largest threat model Milestone 3 allows (1,000 elements, about 15,000 threats, about 49,000 mitigations) ----

type NodeType = 'external_entity' | 'process' | 'data_store';

// The node type and flag set that give one element the most candidates in the shipped library, so a test cannot pass at
// a fraction of the load it claims (as WEB/e2e/bound.ts and Milestone 3's performance test do).
export function busiest(): { type: NodeType; flags: Record<string, boolean>; candidates: number } {
  const library = shippedLibrary();
  let best = { type: 'process' as NodeType, flags: {} as Record<string, boolean>, candidates: 0 };
  for (const type of ['external_entity', 'process', 'data_store'] as const) {
    const names = ELEMENT_FLAGS[type];
    for (let mask = 0; mask < 1 << names.length; mask += 1) {
      const flags = Object.fromEntries(names.filter((_name, index) => (mask & (1 << index)) !== 0).map((name) => [name, true]));
      const candidates = library.candidatesFor({ type, name: 'E', properties: { flags } }).length;
      if (candidates > best.candidates) best = { type, flags, candidates };
    }
  }
  return best;
}

// A threat model of `count` elements of the busiest kind, with the threats the library generates for them.
export async function seedBound(c: V1Client, count = 1000): Promise<{ projectId: string; modelId: string; created: number }> {
  const { type, flags } = busiest();
  const projectId = (await c.post<ApiRecord>('/projects', { name: uniqueName('Bound') })).body.id;
  const modelId = (await c.post<ApiRecord>('/threat-models', { project_id: projectId, name: uniqueName('Largest') })).body.id;
  for (let from = 0; from < count; from += 200) {
    const operations = Array.from({ length: Math.min(200, count - from) }, (_unused, index) => ({
      op: 'create',
      element: { type, name: `Unit ${from + index}`, properties: { flags } },
    }));
    const res = await c.post(`/threat-models/${modelId}/elements/batch`, { operations });
    if (res.status !== 200) throw new Error(`seeding elements failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const run = await c.post<{ created: number }>(`/threat-models/${modelId}/threats/generate`, {});
  if (run.status !== 200) throw new Error(`generation failed: ${run.status}`);
  return { projectId, modelId, created: run.body.created };
}
