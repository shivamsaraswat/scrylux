import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OtmFile, OtmScrylux } from '../../src/index.js';

// What Scrylux reads of an OTM 0.2.0 file (contracts/otm-mapping.md, research #7): only the members the mapping uses,
// typed, with every other member allowed and never walked. Scrylux's own attributes are strict.

const example = (): Record<string, unknown> =>
  JSON.parse(readFileSync(fileURLToPath(new URL('../../../../apps/api/test/exchange/fixtures/otm/EXAMPLE.json', import.meta.url)), 'utf8')) as Record<string, unknown>;

const minimal = () => ({
  otmVersion: '0.2.0',
  project: { name: 'P', id: 'p' },
  components: [{ id: 'c1', name: 'C', type: 'process', parent: { trustZone: 'z1' } }],
  trustZones: [{ id: 'z1', name: 'Z', risk: { trustRating: 10 } }],
  dataflows: [{ id: 'f1', name: 'F', source: 'c1', destination: 'c1' }],
  threats: [{ id: 't1', name: 'T', risk: { likelihood: 10, impact: 90 } }],
  mitigations: [{ id: 'm1', name: 'M', riskReduction: 10 }],
});

describe('OtmFile accepts', () => {
  it('the OTM project’s own example', () => {
    expect(OtmFile.safeParse(example()).success).toBe(true);
  });

  it('a minimal file, and one whose optional lists are missing or null', () => {
    expect(OtmFile.safeParse(minimal()).success).toBe(true);
    expect(OtmFile.safeParse({ otmVersion: '0.2.0', project: { name: 'P', id: 'p' } }).success).toBe(true);
    expect(OtmFile.safeParse({ ...minimal(), components: null, dataflows: null, threats: null, mitigations: null, trustZones: null }).success).toBe(true);
  });

  it('members it does not read, at every level, and never walks into them', () => {
    let deep: unknown[] = [];
    for (let level = 0; level < 10_000; level += 1) deep = [deep];
    const file = { ...minimal(), extra: 1, project: { name: 'P', id: 'p', attributes: { other: deep } } };
    (file.components[0] as Record<string, unknown>).whatever = { deep };
    expect(OtmFile.safeParse(file).success).toBe(true);
  });

  it('a component with tags that include null, as the OTM schema allows', () => {
    const file = minimal();
    (file.components[0] as Record<string, unknown>).tags = ['a', null];
    expect(OtmFile.safeParse(file).success).toBe(true);
  });
});

describe('OtmFile refuses', () => {
  const refusal = (change: (file: ReturnType<typeof minimal>) => void): string[] => {
    const file = minimal();
    change(file);
    const result = OtmFile.safeParse(file);
    expect(result.success).toBe(false);
    return result.error?.issues.map((issue) => issue.path.join('.')) ?? [];
  };

  it('a member it reads with the wrong type, naming the place', () => {
    expect(refusal((file) => { (file.components[0] as Record<string, unknown>).name = 5; })).toContain('components.0.name');
    expect(refusal((file) => { delete (file.dataflows[0] as Record<string, unknown>).source; })).toContain('dataflows.0.source');
    expect(refusal((file) => { (file as Record<string, unknown>).threats = 'no'; })).toContain('threats');
    expect(refusal((file) => { (file as Record<string, unknown>).project = { id: 'p' }; })).toContain('project.name');
    expect(refusal((file) => { (file.trustZones[0] as Record<string, unknown>).parent = { trustZone: 5 }; })).toContain('trustZones.0.parent.trustZone');
  });

  it('a file with no otmVersion or no project', () => {
    expect(OtmFile.safeParse({ project: { name: 'P', id: 'p' } }).success).toBe(false);
    expect(OtmFile.safeParse({ otmVersion: '0.2.0' }).success).toBe(false);
  });

  it('a name over 10,000 characters, and a list of over 100,000 items', () => {
    expect(refusal((file) => { file.components[0]!.name = 'x'.repeat(10_001); })).toContain('components.0.name');
    const many = { ...minimal(), components: Array.from({ length: 100_001 }, (_unused, index) => ({ id: `c${index}`, name: 'C', type: 'process', parent: {} })) };
    expect(OtmFile.safeParse(many).success).toBe(false);
  });
});

describe('OtmScrylux attributes (strict)', () => {
  it('parses what Scrylux writes for each kind of object', () => {
    expect(OtmScrylux.project.safeParse({ format_version: 1, exported_at: 'x', status: 'draft', methodology: 'STRIDE' }).success).toBe(true);
    expect(OtmScrylux.zone.safeParse({ layout: { x: 1, y: 2, width: 100, height: 100 }, parent_boundary_id: null }).success).toBe(true);
    expect(OtmScrylux.zone.safeParse({ outside: true }).success).toBe(true);
    expect(OtmScrylux.component.safeParse({ type: 'process', flags: { internet_facing: true }, layout: { x: 1, y: 2 }, parent_boundary_id: 'z' }).success).toBe(true);
    expect(OtmScrylux.dataflow.safeParse({ flags: {} }).success).toBe(true);
    expect(
      OtmScrylux.threat.safeParse({ element_id: null, likelihood: 'Low', impact: 'High', status: 'open', status_reason: null, origin: 'rule', library_ref: 'r', stale: null }).success,
    ).toBe(true);
    expect(OtmScrylux.mitigation.safeParse({ threat_id: 't', status: 'proposed', external_ref: null }).success).toBe(true);
  });

  it('refuses an unknown key, a wrong version and a bad enum value', () => {
    expect(OtmScrylux.project.safeParse({ format_version: 2, exported_at: 'x', status: 'draft', methodology: 'STRIDE' }).success).toBe(false);
    expect(OtmScrylux.component.safeParse({ type: 'process', flags: {}, layout: null, parent_boundary_id: null, extra: 1 }).success).toBe(false);
    expect(OtmScrylux.component.safeParse({ type: 'data_flow', flags: {}, layout: null, parent_boundary_id: null }).success).toBe(false);
    expect(OtmScrylux.threat.safeParse({ element_id: null, likelihood: 'Huge', impact: 'High', status: 'open', status_reason: null, origin: 'rule', library_ref: 'r', stale: null }).success).toBe(false);
  });
});
