import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOtmFile } from '../../src/exchange/otm-export.js';
import { serializeExport } from '../../src/exchange/scrylux-export.js';
import { ajvDraft07 } from './ajv.js';
import { hostile, snapshotOf, us1Model, type ExchangeFile } from './fixtures.js';

// The OTM 0.2.0 file an export writes (contracts/otm-mapping.md, "Export"): standard fields that describe the model in
// OTM's terms, and everything else in `attributes.scrylux` (FR-011, SC-002).

const at = new Date('2026-10-10T09:30:00.000Z');
const build = (file: ExchangeFile = us1Model()) => buildOtmFile(snapshotOf(file), at);
type Obj = Record<string, unknown>;
const schema = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/otm/otm_schema.json', import.meta.url)), 'utf8')) as object;
const find = (list: unknown, name: string): Obj => (list as Obj[]).find((item) => item.name === name) as Obj;

describe('buildOtmFile header', () => {
  it('marks the file as written by Scrylux, in OTM’s own fields', () => {
    const file = build() as unknown as Obj;
    expect(Object.keys(file)).toEqual(['otmVersion', 'project', 'representations', 'trustZones', 'components', 'dataflows', 'threats', 'mitigations']);
    expect(file.otmVersion).toBe('0.2.0');
    expect(file.project).toEqual({
      name: 'Checkout',
      id: snapshotOf(us1Model()).model.id,
      description: null,
      attributes: { scrylux: { format_version: 1, exported_at: '2026-10-10T09:30:00.000Z', status: 'in_review', methodology: 'STRIDE' } },
    });
    expect(file.representations).toEqual([{ name: 'Diagram', id: 'diagram', type: 'diagram' }]);
  });
});

describe('trust zones', () => {
  const zones = () => (build() as unknown as Obj).trustZones as Obj[];

  it('writes each trust boundary with the trust rating constant, its nesting and its position', () => {
    const internal = find(zones(), 'Internal network');
    expect(internal).toEqual({
      id: 'b-internal',
      name: 'Internal network',
      type: 'trust-boundary',
      risk: { trustRating: 50 },
      representations: [{ representation: 'diagram', id: 'b-internal-shape', position: { x: 40, y: 40 }, size: { width: 700, height: 420 } }],
      attributes: { scrylux: { layout: { x: 40, y: 40, width: 700, height: 420 }, parent_boundary_id: null } },
    });
    const nested = find(zones(), 'DB zone');
    expect(nested.parent).toEqual({ trustZone: 'b-internal' });
    expect((nested.attributes as Obj).scrylux).toEqual({ layout: { x: 400, y: 120, width: 260, height: 240 }, parent_boundary_id: 'b-internal' });
  });

  it('adds the outside zone, last, because nodes sit outside every boundary', () => {
    const list = zones();
    expect(list.at(-1)).toEqual({
      id: 'scrylux-outside',
      name: 'Outside any trust boundary',
      type: 'trust-boundary',
      risk: { trustRating: 50 },
      attributes: { scrylux: { outside: true } },
    });
    expect(list).toHaveLength(3);
  });

  it('leaves the outside zone out when every node is inside a boundary', () => {
    const file = us1Model();
    for (const element of file.elements) {
      if (element.type === 'external_entity' || element.id === 'p-batch') element.parent_boundary_id = 'b-internal';
    }
    expect(((build(file) as unknown as Obj).trustZones as Obj[]).map((zone) => zone.id)).not.toContain('scrylux-outside');
  });

  it('writes a boundary that was never placed without a representation', () => {
    const file = us1Model();
    file.elements[0]!.layout = null;
    expect(find(((build(file) as unknown as Obj).trustZones), 'Internal network').representations).toBeUndefined();
  });
});

describe('components', () => {
  const components = () => (build() as unknown as Obj).components as Obj[];

  it('maps the node types, puts each in its zone, and keeps flags and layout in attributes.scrylux', () => {
    expect(components().map((component) => component.type)).toEqual(['external-entity', 'process', 'process', 'data-store']);
    const api = find(components(), 'API');
    expect(api.parent).toEqual({ trustZone: 'b-internal' });
    expect(api.tags).toEqual(['Node.js', 'Express']);
    expect((api.attributes as Obj).scrylux).toEqual({
      type: 'process',
      flags: { handles_sensitive_data: false, internet_facing: true, requires_authentication: true },
      layout: { x: 60, y: 120 },
      parent_boundary_id: 'b-internal',
    });
    expect(api.representations).toEqual([{ representation: 'diagram', id: 'p-api-shape', position: { x: 60, y: 120 }, size: { width: 140, height: 60 } }]);
  });

  it('puts a node outside every boundary in the outside zone, and writes no tags or representation it does not have', () => {
    const batch = find(components(), 'Batch');
    expect(batch.parent).toEqual({ trustZone: 'scrylux-outside' });
    expect(batch.tags).toBeUndefined();
    expect(batch.representations).toBeUndefined();
    expect(((batch.attributes as Obj).scrylux as Obj).layout).toBeNull();
  });

  it('refers to each threat of the node, with its state, and to that threat’s mitigations', () => {
    const api = find(components(), 'API');
    const references = api.threats as Obj[];
    const spoofing = references.find((reference) => reference.threat === 't-rule-1') as Obj;
    expect(spoofing).toEqual({
      threat: 't-rule-1',
      state: 'exposed',
      // By description: "Rate-limit sign-in" comes before "Require MFA".
      mitigations: [
        { mitigation: 'm-2', state: 'required' },
        { mitigation: 'm-1', state: 'implemented' },
      ],
    });
    expect(references.find((reference) => reference.threat === 't-man-acc')).toMatchObject({ state: 'accepted', mitigations: [{ mitigation: 'm-4', state: 'implemented' }] });
  });
});

describe('data flows', () => {
  it('writes the ends, no two-way flow, the tags, the references and the flags', () => {
    const flows = (build() as unknown as Obj).dataflows as Obj[];
    expect(flows.map((flow) => flow.name)).toEqual(['HTTPS request', 'SQL']);
    expect(find(flows, 'HTTPS request')).toMatchObject({
      id: 'f-https',
      bidirectional: false,
      source: 'e-browser',
      destination: 'p-api',
      tags: ['HTTPS'],
      attributes: { scrylux: { flags: { authenticated: true, encrypted_in_transit: true } } },
    });
    expect((find(flows, 'HTTPS request').threats as Obj[]).map((reference) => reference.threat)).toEqual(['t-rule-3']);
    expect(find(flows, 'SQL').tags).toBeUndefined();
  });
});

describe('threats and mitigations', () => {
  const threats = () => (build() as unknown as Obj).threats as Obj[];

  it('writes the title, the category and the numeric risk, and keeps every Scrylux field in attributes.scrylux', () => {
    const spoofing = threats().find((threat) => threat.id === 't-rule-1') as Obj;
    expect(spoofing).toMatchObject({
      name: 'Spoofing of API',
      description: 'An attacker pretends to be the API.',
      categories: ['Spoofing'],
      risk: { likelihood: 50, impact: 75 },
    });
    expect((spoofing.attributes as Obj).scrylux).toEqual({
      element_id: 'p-api',
      likelihood: 'Medium',
      impact: 'High',
      status: 'open',
      status_reason: null,
      origin: 'rule',
      library_ref: 'process-spoofing',
      stale: null,
    });
    expect(threats().find((threat) => threat.id === 't-rule-3')).toMatchObject({ risk: { likelihood: 25, impact: 25 } });
    expect(((threats().find((threat) => threat.id === 't-rule-2') as Obj).attributes as Obj).scrylux).toMatchObject({ stale: { reason: 'rule_unknown' } });
  });

  it('maps each threat status to an OTM state on the reference', () => {
    const file = build() as unknown as Obj;
    const owners = [...(file.components as Obj[]), ...(file.dataflows as Obj[])];
    const states = new Map<string, unknown>();
    for (const owner of owners) for (const reference of (owner.threats ?? []) as Obj[]) states.set(reference.threat as string, reference.state);
    expect(states.get('t-man-acc')).toBe('accepted');
    expect(states.get('t-man-na')).toBe('not-applicable');
    expect(states.get('t-man-mit-gap')).toBe('mitigated');
    expect(states.get('t-rule-1')).toBe('exposed');
  });

  it('keeps a threat of a boundary, and one of no element, without a reference and with its element in attributes', () => {
    const referenced = new Set(
      [...(((build() as unknown as Obj).components as Obj[])), ...(((build() as unknown as Obj).dataflows as Obj[]))].flatMap((owner) => ((owner.threats ?? []) as Obj[]).map((reference) => reference.threat)),
    );
    expect(referenced.has('t-boundary')).toBe(false);
    expect(referenced.has('t-model-1')).toBe(false);
    expect((((threats().find((threat) => threat.id === 't-boundary') as Obj).attributes as Obj).scrylux as Obj).element_id).toBe('b-internal');
    expect((((threats().find((threat) => threat.id === 't-model-1') as Obj).attributes as Obj).scrylux as Obj).element_id).toBeNull();
  });

  it('writes a mitigation with the risk reduction constant, a name from its first line, and its status and ticket in attributes', () => {
    const file = us1Model();
    file.mitigations[1]!.description = `${'x'.repeat(300)}\nsecond line`;
    const mitigations = (build(file) as unknown as Obj).mitigations as Obj[];
    const first = mitigations.find((item) => item.id === 'm-1') as Obj;
    expect(first).toEqual({
      id: 'm-1',
      name: 'Require MFA',
      description: 'Require MFA',
      riskReduction: 0,
      attributes: { scrylux: { threat_id: 't-rule-1', status: 'implemented', external_ref: 'https://tracker.example/SEC-1' } },
    });
    const long = mitigations.find((item) => item.id === 'm-2') as Obj;
    expect([...(long.name as string)]).toHaveLength(200);
    expect((long.name as string).endsWith('…')).toBe(true);
    expect(long.description).toBe(`${'x'.repeat(300)}\nsecond line`);
  });
});

describe('order, bytes and validity', () => {
  it('orders records as the Scrylux file does, whatever the snapshot’s order', () => {
    const forward = snapshotOf(us1Model());
    const backward = snapshotOf(us1Model());
    backward.elements.reverse();
    backward.threats.reverse();
    backward.mitigations.reverse();
    expect(buildOtmFile(backward, at)).toEqual(buildOtmFile(forward, at));
    expect((((build() as unknown as Obj).threats) as Obj[]).map((threat) => threat.id)).toEqual(
      ((build() as unknown as Obj).threats as Obj[]).map((threat) => threat.id),
    );
  });

  it('differs between two exports of an unchanged model only on the export time (FR-005)', () => {
    const first = serializeExport(buildOtmFile(snapshotOf(us1Model()), new Date('2026-10-10T09:30:00.000Z'))).split('\n');
    const second = serializeExport(buildOtmFile(snapshotOf(us1Model()), new Date('2027-01-02T03:04:05.000Z'))).split('\n');
    expect(second).toHaveLength(first.length);
    const differing = first.flatMap((line, index) => (line === second[index] ? [] : [line.trim().split(':')[0]]));
    expect(differing).toEqual(['"exported_at"']);
  });

  it('writes two-space indentation and one final newline', () => {
    const text = serializeExport(build());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.split('\n')[1]).toBe('  "otmVersion": "0.2.0",');
  });

  it.each([
    ['the US1 model', () => us1Model()],
    ['a model full of hostile text', () => hostile()],
    ['an empty model', () => ({ ...us1Model(), elements: [], threats: [], mitigations: [] })],
  ])('is valid against the OTM schema for %s (SC-002)', (_label, make) => {
    const validate = ajvDraft07().compile(schema);
    const ok = validate(JSON.parse(serializeExport(build(make()))));
    expect(ok, JSON.stringify(validate.errors)).toBe(true);
  });
});
