import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OtmFile, ScryluxFileV1 } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { buildOtmFile } from '../../src/exchange/otm-export.js';
import { parseFile } from '../../src/exchange/import/parse.js';
import { checkPlan, type ImportPlan } from '../../src/exchange/import/plan.js';
import { planOtm } from '../../src/exchange/import/otm.js';
import { planScrylux } from '../../src/exchange/import/scrylux.js';
import { buildScryluxFile } from '../../src/exchange/scrylux-export.js';
import { HttpError } from '../../src/v1/errors.js';
import { snapshotOf, us1Model } from './fixtures.js';

// An OTM file becomes a plan (contracts/otm-mapping.md): strictly when Scrylux wrote it, and by a fixed mapping when
// another tool did (FR-011, FR-012, FR-016, SC-003).

type Obj = Record<string, unknown>;
const fixture = (name: string): Obj => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/otm/${name}`, import.meta.url)), 'utf8')) as Obj;
const plan = (file: unknown): ImportPlan => planOtm(OtmFile.parse(file));
const checked = (file: unknown): ImportPlan => checkPlan(plan(file), { existingNames: [] });
const at = new Date('2026-10-10T09:30:00.000Z');
const scryluxOtm = (): Obj => JSON.parse(JSON.stringify(buildOtmFile(snapshotOf(us1Model()), at))) as Obj;

function refusal(run: () => unknown): HttpError {
  try {
    run();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

const stripPaths = (value: ImportPlan): unknown =>
  JSON.parse(JSON.stringify(value, (key, inner: unknown) => (key === 'path' && typeof inner === 'string' && inner.startsWith('file.') ? undefined : inner)));

describe('an OTM file written by Scrylux (strict)', () => {
  it('plans exactly what the same model’s Scrylux file plans, with no notes', () => {
    const viaOtm = plan(scryluxOtm());
    const viaScrylux = planScrylux(ScryluxFileV1.parse(buildScryluxFile(snapshotOf(us1Model()), at)));
    expect(viaOtm.notes).toEqual([]);
    expect(stripPaths(viaOtm)).toEqual(stripPaths(viaScrylux));
  });

  it('names the place in the OTM file, not in a Scrylux file', () => {
    const rows = plan(scryluxOtm()).models[0]?.elements.map((element) => element.path);
    expect(rows?.slice(0, 2)).toEqual(['file.trustZones.0', 'file.trustZones.1']);
    expect(rows).toContain('file.components.0');
    expect(rows?.at(-1)).toBe('file.dataflows.1');
  });

  it('writes no element for the outside zone', () => {
    const elements = plan(scryluxOtm()).models[0]?.elements ?? [];
    expect(elements.map((element) => element.id)).not.toContain('scrylux-outside');
    expect(elements).toHaveLength(8);
  });

  it('refuses an object without attributes.scrylux, saying the file was changed outside Scrylux', () => {
    const file = scryluxOtm();
    delete ((file.components as Obj[])[2] as Obj).attributes;
    const err = refusal(() => plan(file));
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      'file.components.2.attributes.scrylux: missing; this file was changed outside Scrylux (remove project.attributes.scrylux to import it as another tool\'s file)',
    );
  });

  it('refuses an AI-drafted threat, naming it', () => {
    const file = scryluxOtm();
    (((file.threats as Obj[])[3] as Obj).attributes as Obj).scrylux = { ...(((file.threats as Obj[])[3] as Obj).attributes as Obj).scrylux as Obj, origin: 'ai' };
    expect(refusal(() => plan(file)).message).toBe('file.threats.3.origin: AI-drafted threats cannot be imported yet');
  });

  it('refuses a rule of the Scrylux file broken in attributes.scrylux, naming the place', () => {
    const file = scryluxOtm();
    const open = (file.threats as Obj[]).findIndex((threat) => (((threat.attributes as Obj).scrylux as Obj).status) === 'open');
    (((file.threats as Obj[])[open] as Obj).attributes as Obj).scrylux = { ...(((file.threats as Obj[])[open] as Obj).attributes as Obj).scrylux as Obj, status_reason: 'why' };
    expect(refusal(() => checked(file)).message).toBe(`file.threats.${open}.status_reason: can only be set on a threat that is accepted or not_applicable`);
  });

  it('refuses a key it does not know in attributes.scrylux, and a version it does not read', () => {
    const extra = scryluxOtm();
    (((extra.components as Obj[])[0] as Obj).attributes as Obj).scrylux = { ...(((extra.components as Obj[])[0] as Obj).attributes as Obj).scrylux as Obj, colour: 'red' };
    expect(refusal(() => plan(extra)).message).toContain('file.components.0.attributes.scrylux');
    const version = scryluxOtm();
    (((version.project as Obj).attributes as Obj).scrylux as Obj).format_version = 2;
    expect(refusal(() => plan(version)).message).toBe('file.project.attributes.scrylux.format_version: must be 1; this file is version 2');
  });

  it('refuses a field of the Scrylux file that breaks its rules, naming the OTM object', () => {
    const file = scryluxOtm();
    ((file.components as Obj[])[1] as Obj).name = '';
    expect(refusal(() => plan(file)).message).toMatch(/^file\.components\.1\.name: /);
  });
});

describe('another tool’s OTM file (adapted)', () => {
  const zones = () => [
    { id: 'z1', name: 'Internet', risk: { trustRating: 50 } },
    { id: 'z2', name: 'Private', risk: { trustRating: 50 }, parent: { trustZone: 'z1' }, representations: [{ representation: 'diagram', id: 'z2s', position: { x: 10, y: 20 }, size: { width: 300, height: 200 } }] },
  ];
  const file = (extra: Obj = {}): Obj => ({
    otmVersion: '0.2.0',
    project: { name: 'Shop', id: 'shop' },
    representations: [{ name: 'Diagram', id: 'diagram', type: 'diagram' }],
    trustZones: zones(),
    components: [],
    dataflows: [],
    threats: [],
    mitigations: [],
    ...extra,
  });
  const component = (id: string, type: string, extra: Obj = {}): Obj => ({ id, name: id, type, parent: { trustZone: 'z2' }, ...extra });
  const threat = (id: string, extra: Obj = {}): Obj => ({ id, name: `Threat ${id}`, categories: ['Spoofing'], risk: { likelihood: 50, impact: 50 }, ...extra });
  const elementsOf = (value: unknown) => checked(value).models[0]?.elements ?? [];
  const threatsOf = (value: unknown) => checked(value).models[0]?.threats ?? [];
  const kinds = (value: unknown) => plan(value).notes.map((item) => item.kind);

  describe('trust zones and components', () => {
    it('makes trust zones trust boundaries, nested as the file nests them, with their layout', () => {
      const elements = elementsOf(file());
      expect(elements.map((element) => [element.name, element.type])).toEqual([['Internet', 'trust_boundary'], ['Private', 'trust_boundary']]);
      expect(elements[1]?.parent_boundary_id).toBe(elements[0]?.id);
      expect(elements[1]?.layout).toEqual({ x: 10, y: 20, width: 300, height: 200 });
      expect(elements[0]?.layout).toBeNull();
    });

    it.each([
      ['external-entity', 'external_entity'],
      ['process', 'process'],
      ['data-store', 'data_store'],
      ['EXTERNAL_ENTITY', 'external_entity'],
      ['datastore', 'data_store'],
      ['CD-V2-WEB-CLIENT', 'external_entity'],
      ['third-party-api', 'external_entity'],
      ['postgres-database', 'data_store'],
      ['s3-bucket', 'data_store'],
      ['message-queue', 'data_store'],
    ])('maps the component type %s to %s, with no note', (type, expected) => {
      const result = file({ components: [component('c1', type)] });
      expect(elementsOf(result).at(-1)?.type).toBe(expected);
      expect(kinds(result)).not.toContain('mapped.component_type');
    });

    it('maps any other component type to a process, and says so', () => {
      const result = file({ components: [component('c1', 'cd-v2-microservice')] });
      expect(elementsOf(result).at(-1)?.type).toBe('process');
      expect(plan(result).notes).toEqual([{ path: 'file.components.0', kind: 'mapped.component_type', label: 'c1', detail: 'process' }]);
    });

    it('puts a component in its zone, and one inside another component in the nearest zone, with a note', () => {
      const result = file({ components: [component('c1', 'process'), component('c2', 'process', { parent: { component: 'c1' } })] });
      const elements = elementsOf(result);
      const private1 = elements.find((element) => element.name === 'Private');
      expect(elements.find((element) => element.name === 'c2')?.parent_boundary_id).toBe(private1?.id);
      expect(plan(result).notes).toContainEqual({ path: 'file.components.1', kind: 'moved.nearest_zone', label: 'c2' });
    });

    it('reads tags as technology tags, normalised, and says when it changed them', () => {
      const result = file({ components: [component('c1', 'process', { tags: ['Node.js', 'node.JS', null, '  Express '] })] });
      expect(elementsOf(result).at(-1)?.properties).toEqual({ tags: ['Node.js', 'Express'] });
      expect(plan(result).notes).toContainEqual({ path: 'file.components.0', kind: 'adjusted.tags', label: 'c1' });
    });

    it('places a component from the first diagram representation, relative to its zone, and leaves one it cannot place', () => {
      const result = file({
        components: [
          component('c1', 'process', { representations: [{ representation: 'diagram', id: 'a', position: { x: 5, y: 6 }, size: { width: 50, height: 50 } }] }),
          component('c2', 'process', { representations: [{ representation: 'diagram', id: 'b', position: { x: 500000, y: 1 } }] }),
          component('c3', 'process', { representations: [{ representation: 'other', id: 'c', position: { x: 1, y: 1 } }] }),
        ],
      });
      const elements = elementsOf(result);
      expect(elements.find((element) => element.name === 'c1')?.layout).toEqual({ x: 5, y: 6 });
      expect(elements.find((element) => element.name === 'c2')?.layout).toBeNull();
      expect(elements.find((element) => element.name === 'c3')?.layout).toBeNull();
      expect(plan(result).notes).toContainEqual({ path: 'file.components.1', kind: 'adjusted.layout', label: 'c2', detail: 'unplaced' });
    });

    it('enlarges a trust zone smaller than 40, and leaves a zone with a position but no size unplaced', () => {
      const small = file({ trustZones: [{ id: 'z1', name: 'Tiny', risk: { trustRating: 50 }, representations: [{ representation: 'diagram', id: 'a', position: { x: 1, y: 2 }, size: { width: 10, height: 100 } }] }] });
      expect(elementsOf(small)[0]?.layout).toEqual({ x: 1, y: 2, width: 40, height: 100 });
      expect(plan(small).notes).toContainEqual({ path: 'file.trustZones.0', kind: 'adjusted.layout', label: 'Tiny', detail: 'enlarged' });
      const noSize = file({ trustZones: [{ id: 'z1', name: 'Bare', risk: { trustRating: 50 }, representations: [{ representation: 'diagram', id: 'a', position: { x: 1, y: 2 } }] }] });
      expect(elementsOf(noSize)[0]?.layout).toBeNull();
      expect(plan(noSize).notes).toContainEqual({ path: 'file.trustZones.0', kind: 'adjusted.layout', label: 'Bare', detail: 'unplaced' });
    });

    it('shortens a name over 200 characters and names an empty one, saying so', () => {
      const result = file({ components: [component('c1', 'process', { name: 'x'.repeat(250) }), component('c2', 'process', { name: '   ' })] });
      const elements = elementsOf(result);
      expect([...(elements.find((element) => element.id && element.name.startsWith('xxx'))?.name ?? '')]).toHaveLength(200);
      expect(elements.map((element) => element.name)).toContain('Unnamed process');
      const found = plan(result).notes.map((item) => item.kind);
      expect(found).toContain('adjusted.shortened');
      expect(found).toContain('adjusted.unnamed');
    });
  });

  describe('data flows', () => {
    const two = [component('a', 'process'), component('b', 'data-store')];

    it('makes a flow between two components, and notes a flow that is two-way', () => {
      const result = file({ components: two, dataflows: [{ id: 'f1', name: 'Call', source: 'a', destination: 'b', bidirectional: true }] });
      const elements = elementsOf(result);
      const flow = elements.find((element) => element.type === 'data_flow');
      expect(flow?.name).toBe('Call');
      expect(flow?.source_element_id).toBe(elements.find((element) => element.name === 'a')?.id);
      expect(plan(result).notes).toContainEqual({ path: 'file.dataflows.0', kind: 'not_imported.field', label: 'Call', detail: 'bidirectional' });
    });

    it('leaves out a flow that is not between two components, with a note: to a zone, or from a component to itself', () => {
      const result = file({
        components: two,
        dataflows: [
          { id: 'f1', name: 'To zone', source: 'a', destination: 'z1' },
          { id: 'f2', name: 'Loop', source: 'a', destination: 'a' },
        ],
      });
      expect(elementsOf(result).filter((element) => element.type === 'data_flow')).toEqual([]);
      expect(plan(result).notes.filter((item) => item.kind === 'not_imported.dangling_flow')).toEqual([
        { path: 'file.dataflows.0', kind: 'not_imported.dangling_flow', label: 'To zone' },
        { path: 'file.dataflows.1', kind: 'not_imported.dangling_flow', label: 'Loop' },
      ]);
    });

    it('refuses a flow whose end is no record of the file at all', () => {
      const err = refusal(() => plan(file({ components: two, dataflows: [{ id: 'f1', name: 'F', source: 'a', destination: 'nope' }] })));
      expect(err.message).toBe('file.dataflows.0.destination: must refer to a component in this file');
    });
  });

  describe('threats and mitigations', () => {
    const owner = [component('a', 'process')];

    it('makes one threat per reference, with the state from the reference', () => {
      const result = file({
        components: [component('a', 'process', { threats: [{ threat: 't1', state: 'exposed' }] }), component('b', 'process', { threats: [{ threat: 't1', state: 'mitigated' }] })],
        threats: [threat('t1')],
      });
      const model = checked(result).models[0];
      expect(model?.threats.map((item) => [item.title, item.status, item.origin])).toEqual([
        ['Threat t1', 'open', 'manual'],
        ['Threat t1', 'mitigated', 'manual'],
      ]);
      const elements = model?.elements ?? [];
      expect(model?.threats.map((item) => item.element_id)).toEqual([elements.find((e) => e.name === 'a')?.id, elements.find((e) => e.name === 'b')?.id]);
    });

    it('makes a threat that no object refers to a model-level threat, open', () => {
      const result = file({ components: owner, threats: [threat('t1')] });
      expect(threatsOf(result).map((item) => [item.element_id, item.status])).toEqual([[null, 'open']]);
    });

    it('takes the first category that is a STRIDE category, matching loosely', () => {
      const result = file({
        components: owner,
        threats: [threat('t1', { categories: ['Information Disclosure', 'CWE-79'] }), threat('t2', { categories: ['CWE-79', 'information_disclosure'] }), threat('t3', { categories: ['denial of service'] })],
      });
      expect(threatsOf(result).map((item) => item.category)).toEqual(['Information Disclosure', 'Information Disclosure', 'Denial of Service']);
    });

    it('notes any other category a threat carries, because Scrylux keeps one STRIDE category (FR-016)', () => {
      const result = file({
        components: owner,
        threats: [
          threat('t1', { categories: ['Spoofing', 'Tampering'] }),
          threat('t2', { categories: ['CWE-79', 'Information Disclosure'] }),
          threat('t3', { categories: ['Repudiation'] }),
          threat('t4', { categories: ['Repudiation', null, '  '] }),
        ],
      });
      expect(plan(result).notes.filter((item) => item.detail === 'categories').map((item) => [item.path, item.label])).toEqual([
        ['file.threats.0', 'Threat t1'],
        ['file.threats.1', 'Threat t2'],
      ]);
    });

    it('leaves out a threat with no STRIDE category, with a note', () => {
      const result = file({ components: [component('a', 'process', { threats: [{ threat: 't1', state: 'exposed' }] })], threats: [threat('t1', { categories: ['LINDDUN-L', null] })] });
      expect(threatsOf(result)).toEqual([]);
      expect(plan(result).notes).toContainEqual({ path: 'file.threats.0', kind: 'not_imported.threat_category', label: 'Threat t1' });
    });

    it.each([
      [null, 'Medium'],
      [0, 'Low'],
      [33, 'Low'],
      [34, 'Medium'],
      [66, 'Medium'],
      [67, 'High'],
      [100, 'High'],
    ])('buckets a likelihood of %s as %s', (value, expected) => {
      const result = file({ components: owner, threats: [threat('t1', { risk: { likelihood: value, impact: 50 } })] });
      expect(threatsOf(result)[0]?.likelihood).toBe(expected);
    });

    it('notes a missing likelihood and clamps one outside 0 to 100, saying so', () => {
      const missing = file({ components: owner, threats: [threat('t1', { risk: { likelihood: null, impact: 50 } })] });
      expect(plan(missing).notes).toContainEqual({ path: 'file.threats.0', kind: 'mapped.severity', label: 'Threat t1', detail: 'null' });
      const clamped = file({ components: owner, threats: [threat('t1', { risk: { likelihood: -5, impact: 150 } })] });
      expect(threatsOf(clamped)[0]).toMatchObject({ likelihood: 'Low', impact: 'High' });
      expect(plan(clamped).notes.filter((item) => item.kind === 'mapped.risk_clamped')).toHaveLength(2);
    });

    it.each([
      ['exposed', 'open'],
      ['Open', 'open'],
      ['new', 'open'],
      ['mitigated', 'mitigated'],
      ['Accepted', 'accepted'],
      ['not-applicable', 'not_applicable'],
      ['N/A', 'not_applicable'],
      ['hidden', 'not_applicable'],
    ])('reads the threat state %j as %s, with no note', (state, expected) => {
      const result = file({ components: [component('a', 'process', { threats: [{ threat: 't1', state }] })], threats: [threat('t1')] });
      expect(threatsOf(result)[0]?.status).toBe(expected);
      expect(kinds(result)).not.toContain('mapped.status');
    });

    it('reads an unknown threat state as open, and says so', () => {
      const result = file({ components: [component('a', 'process', { threats: [{ threat: 't1', state: 'partly mitigated' }] })], threats: [threat('t1')] });
      expect(threatsOf(result)[0]?.status).toBe('open');
      expect(plan(result).notes).toContainEqual({ path: 'file.components.0.threats.0', kind: 'mapped.status', label: 'Threat t1', detail: 'other' });
    });

    it('turns each mitigation reference into a mitigation of that threat, with its state', () => {
      const result = file({
        components: [
          component('a', 'process', {
            threats: [
              {
                threat: 't1',
                state: 'exposed',
                mitigations: [
                  { mitigation: 'm1', state: 'implemented' },
                  { mitigation: 'm1', state: 'required' },
                  { mitigation: 'm2', state: 'verified' },
                  { mitigation: 'm2', state: 'strange' },
                  { mitigation: null, state: 'implemented' },
                ],
              },
            ],
          }),
        ],
        threats: [threat('t1')],
        mitigations: [
          { id: 'm1', name: 'Add MFA', description: 'Add MFA everywhere', riskReduction: 0 },
          { id: 'm2', name: 'Patch', description: '', riskReduction: 0 },
        ],
      });
      const mitigations = checked(result).models[0]?.mitigations ?? [];
      expect(mitigations.map((item) => [item.description, item.status])).toEqual([
        ['Add MFA everywhere', 'implemented'],
        ['Add MFA everywhere', 'proposed'],
        ['Patch', 'verified'],
        ['Patch', 'proposed'],
      ]);
      expect(plan(result).notes).toContainEqual({ path: 'file.components.0.threats.0.mitigations.3', kind: 'mapped.status', label: 'Patch', detail: 'other' });
    });

    it('writes the name above the description when the description does not start with it', () => {
      const result = file({
        components: [component('a', 'process', { threats: [{ threat: 't1', state: 'exposed', mitigations: [{ mitigation: 'm1', state: 'required' }] }] })],
        threats: [threat('t1')],
        mitigations: [{ id: 'm1', name: 'Add MFA', description: 'Everywhere, for staff.', riskReduction: 0 }],
      });
      expect(checked(result).models[0]?.mitigations[0]?.description).toBe('Add MFA\n\nEverywhere, for staff.');
    });

    it('refuses a reference to a threat or a mitigation that is not in the file', () => {
      expect(refusal(() => plan(file({ components: [component('a', 'process', { threats: [{ threat: 'nope', state: 'exposed' }] })] }))).message).toBe(
        'file.components.0.threats.0.threat: must refer to a threat in this file',
      );
      const missing = file({
        components: [component('a', 'process', { threats: [{ threat: 't1', state: 'exposed', mitigations: [{ mitigation: 'nope', state: 'required' }] }] })],
        threats: [threat('t1')],
      });
      expect(refusal(() => plan(missing)).message).toBe('file.components.0.threats.0.mitigations.0.mitigation: must refer to a mitigation in this file');
    });

    it('moves the threats of a flow that was left out to the model, with a note', () => {
      const result = file({
        components: [component('a', 'process')],
        dataflows: [{ id: 'f1', name: 'Loop', source: 'a', destination: 'a', threats: [{ threat: 't1', state: 'exposed' }] }],
        threats: [threat('t1')],
      });
      expect(threatsOf(result).map((item) => item.element_id)).toEqual([null]);
      expect(plan(result).notes).toContainEqual({ path: 'file.dataflows.0.threats.0', kind: 'moved.model_level', label: 'Threat t1' });
    });

    it('always imports threats as manual, and never reads a rule or a stale mark from the file', () => {
      const result = file({
        components: [component('a', 'process', { threats: [{ threat: 't1', state: 'exposed' }] })],
        threats: [threat('t1', { attributes: { scrylux: { origin: 'rule', library_ref: 'x', stale: { reason: 'rule_unknown' } } } })],
      });
      expect(threatsOf(result)[0]).toMatchObject({ origin: 'manual', library_ref: null, stale: null, status_reason: null });
    });

    it('refuses a repeated threat or mitigation id', () => {
      expect(refusal(() => plan(file({ threats: [threat('t1'), threat('t1')] }))).message).toBe('file.threats.1.id: must be different from every other id in the file');
      expect(refusal(() => plan(file({ mitigations: [{ id: 'm', name: 'M', riskReduction: 0 }, { id: 'm', name: 'M', riskReduction: 0 }] }))).message).toBe(
        'file.mitigations.1.id: must be different from every other id in the file',
      );
    });
  });

  describe('what it does not carry over (FR-016)', () => {
    it('notes content with no place in a threat model, once per object, naming the field', () => {
      const result = file({
        project: { name: 'Shop', id: 'shop', description: 'D', owner: 'O', ownerContact: 'C', tags: ['t'], attributes: { cmdb: 1 } },
        assets: [{ id: 'a1', name: 'Card data' }],
        representations: [{ name: 'Diagram', id: 'diagram', type: 'diagram' }, { name: 'Code', id: 'code', type: 'code' }],
        trustZones: [{ id: 'z1', name: 'Zone', description: 'ZD', risk: { trustRating: 20 } }],
        components: [component('a', 'process', { description: 'CD', parent: { trustZone: 'z1' }, threats: [{ threat: 't1', state: 'exposed' }] })],
        threats: [threat('t1', { cwes: ['CWE-79'], tags: ['x'], risk: { likelihood: 50, likelihoodComment: 'LC', impact: 50, impactComment: 'IC' } })],
        mitigations: [{ id: 'm1', name: 'Unused', riskReduction: 40 }],
      });
      const details = (kind: string) => plan(result).notes.filter((item) => item.kind === kind).map((item) => [item.path, item.label, item.detail]);
      expect(details('not_imported.field')).toEqual(
        expect.arrayContaining([
          ['file.project', 'Shop', 'description'],
          ['file.project', 'Shop', 'owner'],
          ['file.project', 'Shop', 'ownerContact'],
          ['file.project', 'Shop', 'tags'],
          ['file.project', 'Shop', 'attributes'],
          ['file.trustZones.0', 'Zone', 'description'],
          ['file.trustZones.0', 'Zone', 'trustRating'],
          ['file.components.0', 'a', 'description'],
          ['file.threats.0', 'Threat t1', 'cwes'],
          ['file.threats.0', 'Threat t1', 'tags'],
          ['file.threats.0', 'Threat t1', 'likelihoodComment'],
          ['file.threats.0', 'Threat t1', 'impactComment'],
          ['file.mitigations.0', 'Unused', 'riskReduction'],
          ['file.mitigations.0', 'Unused', 'unreferencedMitigation'],
        ]),
      );
      expect(details('not_imported.asset')).toEqual([['file.assets.0', 'Card data', undefined]]);
      expect(details('not_imported.representation')).toEqual([['file.representations.1', 'Code', undefined]]);
    });

    it('notes nothing for what carries no information: Scrylux’s own constants, and presentation data', () => {
      const result = file({
        trustZones: [{ id: 'z1', name: 'Zone', type: 'whatever', risk: { trustRating: 50 }, representations: [{ representation: 'diagram', id: 'ignored-id', name: 'ignored name' }] }],
        components: [component('a', 'process', { parent: { trustZone: 'z1' }, representations: [{ representation: 'diagram', id: 'r', position: { x: 1, y: 1 }, size: { width: 99, height: 99 } }] })],
        threats: [threat('t1')],
      });
      expect(plan(result).notes).toEqual([]);
    });
  });

  describe('files', () => {
    it('takes the model name from the project, and the status draft', () => {
      const model = plan(file()).models[0];
      expect(model?.threatModel).toMatchObject({ name: 'Shop', status: 'draft', methodology: 'STRIDE' });
      expect(checked(file({ project: { name: '  ', id: 'p' } })).models[0]?.name_issue).toBe('empty');
    });

    it('imports the OTM project’s own example (SC-003)', () => {
      const result = checked(fixture('EXAMPLE.json'));
      const model = result.models[0];
      expect([model?.elements.length, model?.threats.length, model?.mitigations.length]).toEqual([8, 2, 2]);
      expect(model?.elements.filter((element) => element.type === 'trust_boundary').map((element) => element.name)).toEqual(['Internet', 'Private']);
      expect(model?.elements.filter((element) => element.type !== 'trust_boundary' && element.type !== 'data_flow').map((element) => [element.name, element.type])).toEqual([
        ['Web Client', 'external_entity'],
        ['Web Service', 'process'],
        ['Customer Database', 'data_store'],
        ['Class CustomerDatabase', 'process'],
      ]);
      expect(model?.threats.map((threat) => [threat.category, threat.likelihood, threat.impact, threat.status])).toEqual([
        ['Spoofing', 'Medium', 'High', 'open'],
        ['Spoofing', 'Medium', 'High', 'open'],
      ]);
      expect(model?.mitigations.map((item) => item.status)).toEqual(['implemented', 'proposed']);
      const byKind = (kind: string) => result.notes.filter((item) => item.kind === kind).length;
      expect({ field: byKind('not_imported.field'), asset: byKind('not_imported.asset'), representation: byKind('not_imported.representation'), type: byKind('mapped.component_type') }).toEqual({
        field: 22,
        asset: 2,
        representation: 1,
        type: 2,
      });
    });

    it('refuses a file of another OTM version, naming the one it reads', () => {
      const err = refusal(() => parseFile('otm', fixture('mobile-cloud.otm.json')));
      expect(err.status).toBe(400);
      expect(err.message).toBe('file: not an OTM 0.2.0 file');
    });
  });
});
