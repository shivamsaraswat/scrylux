import { describe, expect, it } from 'vitest';
import { ScryluxFileV1 } from '../../src/index.js';

// The Scrylux file, format version 1 (contracts/scrylux-file.md, data-model.md): the field rules of the create
// inputs, with ids that are opaque strings and no key left out.

type Row = Record<string, unknown>;
type Mutable = { [key: string]: unknown; threat_model: Row; elements: Row[]; threats: Row[]; mitigations: Row[] };

const valid = (): Mutable => ({
  format: 'scrylux',
  format_version: 1,
  exported_at: '2026-10-10T09:30:00.000Z',
  project: { name: 'Payments' },
  threat_model: { name: 'Checkout', methodology: 'STRIDE', status: 'in_review' },
  elements: [
    { id: 'b1', type: 'trust_boundary', name: 'VPC', properties: {}, layout: { x: 40, y: 40, width: 600, height: 400 }, parent_boundary_id: null, source_element_id: null, target_element_id: null },
    { id: 'p1', type: 'process', name: 'API', properties: { tags: ['Node.js'], flags: { internet_facing: true, runs_privileged: false } }, layout: { x: 10, y: 20 }, parent_boundary_id: 'b1', source_element_id: null, target_element_id: null },
    { id: 'p2', type: 'process', name: 'Batch', properties: {}, layout: null, parent_boundary_id: null, source_element_id: null, target_element_id: null },
    { id: 'f1', type: 'data_flow', name: 'Call', properties: { flags: { encrypted_in_transit: true } }, layout: null, parent_boundary_id: null, source_element_id: 'p1', target_element_id: 'p2' },
  ],
  threats: [
    { id: 't1', element_id: 'p1', category: 'Spoofing', title: 'Spoofed', description: 'text', likelihood: 'Medium', impact: 'High', status: 'accepted', status_reason: 'why', origin: 'rule', library_ref: 'r1', stale: { reason: 'rule_unknown' } },
    { id: 't2', element_id: null, category: 'Tampering', title: 'Model level', description: '', likelihood: 'Low', impact: 'Low', status: 'open', status_reason: null, origin: 'manual', library_ref: null, stale: null },
  ],
  mitigations: [{ id: 'm1', threat_id: 't1', description: 'Do it', status: 'implemented', external_ref: 'https://tracker.example/1' }],
});

function refusal(change: (file: Mutable) => void): string[] {
  const file = valid();
  change(file);
  const result = ScryluxFileV1.safeParse(file);
  expect(result.success, 'the change should be refused').toBe(false);
  return result.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
}

describe('ScryluxFileV1 accepts', () => {
  it('a complete file, unchanged', () => {
    expect(ScryluxFileV1.parse(valid())).toEqual(valid());
  });

  it('an empty model', () => {
    const file = { ...valid(), elements: [], threats: [], mitigations: [] };
    expect(ScryluxFileV1.safeParse(file).success).toBe(true);
  });

  it('origin ai: refusing it is the planner’s rule, not the schema’s', () => {
    expect(ScryluxFileV1.safeParse({ ...valid(), threats: [{ ...valid().threats[1], origin: 'ai' }] }).success).toBe(true);
  });

  it('an empty or over-long threat model name: a name issue is reported, never refused here', () => {
    expect(ScryluxFileV1.safeParse({ ...valid(), threat_model: { ...valid().threat_model, name: '' } }).success).toBe(true);
    expect(ScryluxFileV1.safeParse({ ...valid(), threat_model: { ...valid().threat_model, name: 'x'.repeat(300) } }).success).toBe(true);
  });

  it('trims tags and text, as the create inputs do', () => {
    const file = valid();
    file.elements[1]!.properties = { tags: [' Node.js '] };
    file.elements[1]!.name = '  API  ';
    const parsed = ScryluxFileV1.parse(file);
    expect(parsed.elements[1]?.properties).toEqual({ tags: ['Node.js'] });
    expect(parsed.elements[1]?.name).toBe('API');
  });
});

describe('ScryluxFileV1 refuses, naming the field', () => {
  it('a format other than scrylux', () => {
    expect(refusal((file) => { file.format = 'otm'; }).join('\n')).toContain('format:');
  });

  it('a format_version other than 1, naming the file’s version when it is a small whole number (spec edge case)', () => {
    expect(refusal((file) => { file.format_version = 2; })).toContain('format_version: must be 1; this file is version 2');
    expect(refusal((file) => { file.format_version = 999; })).toContain('format_version: must be 1; this file is version 999');
  });

  it.each([
    ['a number over 999', 1000],
    ['zero', 0],
    ['a negative number', -3],
    ['a decimal', 1.5],
    ['a string', 'two'],
    ['null', null],
    ['an object', { v: 2 }],
  ])('a format_version that is %s, without repeating it', (_label, value) => {
    expect(refusal((file) => { file.format_version = value; })).toContain('format_version: must be 1');
  });

  it.each([
    ['an id of 0 characters', (file: Mutable) => { file.elements[0]!.id = ''; }, 'elements.0.id'],
    ['an id of 101 characters', (file: Mutable) => { file.threats[0]!.id = 'x'.repeat(101); }, 'threats.0.id'],
    ['an element name of 201 code points', (file: Mutable) => { file.elements[1]!.name = 'x'.repeat(201); }, 'elements.1.name'],
    ['an empty element name', (file: Mutable) => { file.elements[1]!.name = '  '; }, 'elements.1.name'],
    ['a threat title of 201 code points', (file: Mutable) => { file.threats[0]!.title = '😀'.repeat(201); }, 'threats.0.title'],
    ['a status reason of 10,001 code points', (file: Mutable) => { file.threats[0]!.status_reason = 'x'.repeat(10_001); }, 'threats.0.status_reason'],
    ['an unknown category', (file: Mutable) => { file.threats[0]!.category = 'Linkability'; }, 'threats.0.category'],
    ['an unknown likelihood', (file: Mutable) => { file.threats[0]!.likelihood = 'Extreme'; }, 'threats.0.likelihood'],
    ['an unknown status', (file: Mutable) => { file.threats[0]!.status = 'done'; }, 'threats.0.status'],
    ['an unknown origin', (file: Mutable) => { file.threats[0]!.origin = 'robot'; }, 'threats.0.origin'],
    ['an invalid stale reason', (file: Mutable) => { file.threats[0]!.stale = { reason: 'because' }; }, 'threats.0.stale'],
    ['a javascript: ticket', (file: Mutable) => { file.mitigations[0]!.external_ref = 'javascript:alert(1)'; }, 'mitigations.0.external_ref'],
    ['a ticket with whitespace', (file: Mutable) => { file.mitigations[0]!.external_ref = 'https://a.example/a b'; }, 'mitigations.0.external_ref'],
    ['an unknown mitigation status', (file: Mutable) => { file.mitigations[0]!.status = 'done'; }, 'mitigations.0.status'],
    ['an unknown element type', (file: Mutable) => { file.elements[1]!.type = 'queue'; }, 'elements.1.type'],
    ['an unknown methodology', (file: Mutable) => { file.threat_model.methodology = 'LINDDUN'; }, 'threat_model.methodology'],
  ])('%s', (_label, change, path) => {
    expect(refusal(change).some((line) => line.startsWith(path))).toBe(true);
  });

  it.each([
    ['a tag of 51 characters', (file: Mutable) => { file.elements[1]!.properties = { tags: ['x'.repeat(51)] }; }],
    ['21 tags', (file: Mutable) => { file.elements[1]!.properties = { tags: Array.from({ length: 21 }, (_u, index) => `t${index}`) }; }],
    ['tags that differ only by case', (file: Mutable) => { file.elements[1]!.properties = { tags: ['A', 'a'] }; }],
    ['a flag that does not apply to the type', (file: Mutable) => { file.elements[1]!.properties = { flags: { encrypted_at_rest: true } }; }],
    ['an unknown flag', (file: Mutable) => { file.elements[1]!.properties = { flags: { made_up: true } }; }],
    ['a flag that is not a boolean', (file: Mutable) => { file.elements[1]!.properties = { flags: { internet_facing: 'yes' } }; }],
    ['an unknown properties key', (file: Mutable) => { file.elements[1]!.properties = { colour: 'red' }; }],
    ['a node layout with a width', (file: Mutable) => { file.elements[1]!.layout = { x: 1, y: 2, width: 100 }; }],
    ['a boundary smaller than 40', (file: Mutable) => { file.elements[0]!.layout = { x: 0, y: 0, width: 39, height: 100 }; }],
    ['a boundary with no size', (file: Mutable) => { file.elements[0]!.layout = { x: 0, y: 0 }; }],
    ['a coordinate beyond 100,000', (file: Mutable) => { file.elements[1]!.layout = { x: 100_001, y: 0 }; }],
    ['a flow with a layout', (file: Mutable) => { file.elements[3]!.layout = { x: 0, y: 0 }; }],
  ])('%s', (_label, change) => {
    expect(refusal(change).some((line) => line.startsWith('elements.'))).toBe(true);
  });

  it('a missing key: every key is required', () => {
    for (const key of ['id', 'type', 'name', 'properties', 'layout', 'parent_boundary_id', 'source_element_id', 'target_element_id']) {
      const file = valid();
      delete file.elements[1]![key];
      expect(ScryluxFileV1.safeParse(file).success, key).toBe(false);
    }
    for (const key of ['element_id', 'category', 'title', 'description', 'likelihood', 'impact', 'status', 'status_reason', 'origin', 'library_ref', 'stale']) {
      const file = valid();
      delete file.threats[0]![key];
      expect(ScryluxFileV1.safeParse(file).success, key).toBe(false);
    }
    for (const top of ['format', 'format_version', 'exported_at', 'project', 'threat_model', 'elements', 'threats', 'mitigations']) {
      const file = valid();
      delete file[top];
      expect(ScryluxFileV1.safeParse(file).success, top).toBe(false);
    }
  });

  it('an unknown key anywhere', () => {
    const cases: ((file: Mutable) => void)[] = [
      (file) => { file.extra = 1; },
      (file) => { file.threat_model.extra = 1; },
      (file) => { file.elements[0]!.extra = 1; },
      (file) => { file.threats[0]!.risk = 'High'; },
      (file) => { file.mitigations[0]!.created_at = 'x'; },
    ];
    for (const change of cases) expect(refusal(change).length).toBeGreaterThan(0);
  });

  it('never repeats a value from the file in a message', () => {
    const secret = 'SECRET-VALUE-XYZ';
    const messages = refusal((file) => {
      file.threats[0]!.category = secret;
      file.mitigations[0]!.external_ref = `ftp://${secret}`;
      file.elements[1]!.properties = { tags: [secret.repeat(10)] };
    });
    expect(messages.join('\n')).not.toContain(secret);
  });
});
