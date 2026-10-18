import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NOTE_KINDS, ThreatDragonFile } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../../src/exchange/import/parse.js';
import { checkPlan, summarize, type ImportPlan } from '../../src/exchange/import/plan.js';
import { planThreatDragon } from '../../src/exchange/import/threat-dragon.js';
import { HttpError } from '../../src/v1/errors.js';

// A Threat Dragon version 2 file becomes one plan model per diagram (contracts/threat-dragon-mapping.md): FR-013,
// FR-013a, FR-014, FR-016, SC-003.

type Obj = Record<string, unknown>;
const dir = fileURLToPath(new URL('./fixtures/threat-dragon/', import.meta.url));
const demo = (name: string): Obj => JSON.parse(readFileSync(`${dir}${name}`, 'utf8')) as Obj;
const plan = (file: unknown): ImportPlan => planThreatDragon(ThreatDragonFile.parse(file));
const checked = (file: unknown): ImportPlan => checkPlan(plan(file), { existingNames: [] });
const notesOf = (file: unknown) => plan(file).notes;

function refusal(run: () => unknown): HttpError {
  try {
    run();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

const cell = (id: string, shape: string, data: Obj = {}, extra: Obj = {}): Obj => ({ id, shape, zIndex: 1, data: { name: id, ...data }, ...extra });
const node = (id: string, shape: string, x: number, y: number, data: Obj = {}, extra: Obj = {}): Obj => cell(id, shape, data, { position: { x, y }, size: { width: 60, height: 40 }, ...extra });
const flow = (id: string, source: string | null, target: string | null, data: Obj = {}, extra: Obj = {}): Obj => cell(id, 'flow', data, { source: source === null ? { x: 1, y: 1 } : { cell: source }, target: target === null ? { x: 9, y: 9 } : { cell: target }, ...extra });
const box = (id: string, x: number, y: number, w: number, h: number, data: Obj = {}): Obj => cell(id, 'trust-boundary-box', data, { position: { x, y }, size: { width: w, height: h } });
const threat = (title: string, extra: Obj = {}): Obj => ({ title, description: `${title} text`, status: 'Open', severity: 'High', type: 'Spoofing', mitigation: '', ...extra });
const diagram = (cells: Obj[], extra: Obj = {}): Obj => ({ title: 'Main', diagramType: 'STRIDE', cells, ...extra });
const file = (diagrams: Obj[] = [diagram([])], summary: Obj = { title: 'Shop' }): Obj => ({ version: '2.3.0', summary, detail: { diagrams } });
const model0 = (value: unknown) => checked(value).models[0];

describe('cells', () => {
  it('maps actors, processes and stores to external entities, processes and data stores, keeping names', () => {
    const result = file([diagram([node('a', 'actor', 0, 0, { name: 'User' }), node('p', 'process', 10, 10, { name: 'API' }), node('s', 'store', 20, 20, { name: 'DB' })])]);
    expect(model0(result)?.elements.map((element) => [element.type, element.name])).toEqual([['external_entity', 'User'], ['process', 'API'], ['data_store', 'DB']]);
    expect(notesOf(result)).toEqual([]);
  });

  it('maps a flow between two nodes to a data flow with its ends', () => {
    const result = file([diagram([node('a', 'actor', 0, 0), node('p', 'process', 10, 10), flow('f', 'a', 'p', { name: 'Call' })])]);
    const elements = model0(result)?.elements ?? [];
    const made = elements.find((element) => element.type === 'data_flow');
    expect([made?.name, made?.source_element_id, made?.target_element_id]).toEqual(['Call', elements[0]?.id, elements[1]?.id]);
    expect(made?.layout).toBeNull();
  });

  it('leaves out a flow not attached to two nodes, a text block and a boundary line, with a note each', () => {
    const result = file([
      diagram([
        node('a', 'actor', 0, 0),
        flow('open', 'a', null, { name: 'Loose' }),
        flow('self', 'a', 'a', { name: 'Self' }),
        cell('line', 'trust-boundary-curve', { name: 'Perimeter' }),
        cell('text', 'td-text-block', { name: 'Legend' }),
        cell('odd', 'td-something', { name: 'Odd' }),
      ]),
    ]);
    expect(model0(result)?.elements).toHaveLength(1);
    const path = 'file.detail.diagrams.0.cells';
    expect(notesOf(result)).toEqual([
      { path: `${path}.1`, kind: 'not_imported.dangling_flow', label: 'Loose' },
      { path: `${path}.2`, kind: 'not_imported.dangling_flow', label: 'Self' },
      { path: `${path}.3`, kind: 'not_imported.boundary_line', label: 'Perimeter' },
      { path: `${path}.4`, kind: 'not_imported.text_block', label: 'Legend' },
      { path: `${path}.5`, kind: 'not_imported.field', label: 'Odd', detail: 'shape' },
    ]);
  });

  it('refuses a flow that is attached to a cell the diagram does not hold', () => {
    const err = refusal(() => plan(file([diagram([node('a', 'actor', 0, 0), flow('f', 'a', 'ghost')])])));
    expect(err.message).toBe('file.detail.diagrams.0.cells.1.target.cell: must refer to a cell in this diagram');
  });

  it('names an empty name “Unnamed …” and shortens one over 200 characters, saying so', () => {
    const result = file([diagram([node('a', 'actor', 0, 0, { name: '  ' }), node('p', 'process', 0, 0, { name: 'x'.repeat(250) })])]);
    const names = model0(result)?.elements.map((element) => element.name);
    expect(names?.[0]).toBe('Unnamed external entity');
    expect([...(names?.[1] ?? '')]).toHaveLength(200);
    expect(notesOf(result).map((item) => item.kind)).toEqual(['adjusted.unnamed', 'adjusted.shortened']);
  });

  it('refuses a repeated cell id', () => {
    expect(refusal(() => checked(file([diagram([node('a', 'actor', 0, 0), node('a', 'process', 0, 0)])]))).message).toBe('file.detail.diagrams.0.cells.1.id: must be different from every other id in the file');
  });
});

describe('properties', () => {
  const props = (shape: string, data: Obj) => model0(file([diagram([node('n', shape, 0, 0, data)])]))?.elements[0]?.properties;

  it('sets a flag for a true property, and leaves it not assessed for a false one', () => {
    expect(props('actor', { providesAuthentication: true })).toEqual({ flags: { authenticated: true } });
    expect(props('actor', { providesAuthentication: false })).toEqual({});
    expect(props('store', { isEncrypted: true, storesCredentials: true })).toEqual({ flags: { encrypted_at_rest: true, stores_sensitive_data: true } });
    expect(props('store', { isEncrypted: false, storesCredentials: false })).toEqual({});
  });

  it('maps a flow’s encryption and protocol, and a web application to technology tags', () => {
    const result = file([diagram([node('a', 'actor', 0, 0), flow('f', 'a', 'a2', { isEncrypted: true, protocol: 'HTTPS' }), node('a2', 'process', 5, 5, { isWebApplication: true })])]);
    const elements = model0(result)?.elements ?? [];
    expect(elements.find((element) => element.type === 'data_flow')?.properties).toEqual({ tags: ['HTTPS'], flags: { encrypted_in_transit: true } });
    expect(elements.find((element) => element.type === 'process')?.properties).toEqual({ tags: ['web application'] });
  });

  it('notes a property that is true and has no place, once, with its name', () => {
    const result = file([diagram([node('p', 'process', 0, 0, { isPublicNetwork: true, storesInventory: true, isALog: false, privilegeLevel: 'root', outOfScope: true, reasonOutOfScope: 'later', description: 'Does things', providesAuthentication: true })])]);
    const details = notesOf(result).map((item) => item.detail);
    expect(details).toEqual(['providesAuthentication', 'isPublicNetwork', 'storesInventory', 'privilegeLevel', 'outOfScope', 'description'].sort((a, b) => details.indexOf(a) - details.indexOf(b)));
    expect(new Set(details)).toEqual(new Set(['providesAuthentication', 'isPublicNetwork', 'storesInventory', 'privilegeLevel', 'outOfScope', 'description']));
    expect(notesOf(result).every((item) => item.kind === 'not_imported.field' && item.label === 'p')).toBe(true);
  });

  it('notes nothing for presentation data', () => {
    const result = file([
      diagram([
        node('a', 'actor', 0, 0, { type: 'tm.Actor', isTrustBoundary: false, hasOpenThreats: true }, { attrs: { body: { stroke: 'red' } }, zIndex: 5, visible: true, vertices: [{ x: 1, y: 2 }], connector: 'smooth' }),
      ], { thumbnail: './x.jpg', placeholder: 'p', version: '2.3.0' }),
    ]);
    expect(notesOf(result)).toEqual([]);
  });
});

describe('trust boundaries and geometry', () => {
  it('makes a box a trust boundary and puts the nodes drawn inside it in it, with positions relative to it', () => {
    const result = file([diagram([box('b', 100, 100, 400, 300, { name: 'Inside' }), node('in', 'process', 150, 140, { name: 'In' }), node('out', 'process', 900, 900, { name: 'Out' })])]);
    const elements = model0(result)?.elements ?? [];
    const boundary = elements.find((element) => element.type === 'trust_boundary');
    expect(boundary?.layout).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    const inside = elements.find((element) => element.name === 'In');
    expect(inside?.parent_boundary_id).toBe(boundary?.id);
    expect(inside?.layout).toEqual({ x: 50, y: 40 });
    const outside = elements.find((element) => element.name === 'Out');
    expect(outside?.parent_boundary_id).toBeNull();
    expect(outside?.layout).toEqual({ x: 900, y: 900 });
  });

  it('nests a box inside the smallest box that holds it, and a node in the innermost', () => {
    const result = file([diagram([box('outer', 0, 0, 1000, 1000, { name: 'Outer' }), box('inner', 100, 100, 300, 300, { name: 'Inner' }), node('n', 'process', 150, 150, { name: 'N' })])]);
    const elements = model0(result)?.elements ?? [];
    const by = (name: string) => elements.find((element) => element.name === name);
    expect(by('Outer')?.parent_boundary_id).toBeNull();
    expect(by('Inner')?.parent_boundary_id).toBe(by('Outer')?.id);
    expect(by('N')?.parent_boundary_id).toBe(by('Inner')?.id);
    expect(by('Inner')?.layout).toEqual({ x: 100, y: 100, width: 300, height: 300 });
  });

  it('leaves a coordinate beyond 100,000 unplaced and enlarges a box smaller than 40, each with a note', () => {
    const result = file([diagram([node('far', 'process', 500_000, 0, { name: 'Far' }), box('tiny', 0, 0, 10, 20, { name: 'Tiny' })])]);
    const elements = model0(result)?.elements ?? [];
    expect(elements.find((element) => element.name === 'Far')?.layout).toBeNull();
    expect(elements.find((element) => element.name === 'Tiny')?.layout).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(notesOf(result)).toEqual([
      { path: 'file.detail.diagrams.0.cells.0', kind: 'adjusted.layout', label: 'Far', detail: 'unplaced' },
      { path: 'file.detail.diagrams.0.cells.1', kind: 'adjusted.layout', label: 'Tiny', detail: 'enlarged' },
    ]);
  });
});

describe('threats', () => {
  const threatsOf = (cells: Obj[], extra: Obj = {}) => model0(file([diagram(cells, extra)]));
  const withThreats = (...threats: Obj[]) => [node('n', 'process', 0, 0, { name: 'N', threats })];

  it('keeps the title, description and STRIDE category, matching the type ignoring case', () => {
    const result = threatsOf(
      withThreats(threat('A', { type: 'Information disclosure' }), threat('B', { type: 'Denial of service' }), threat('C', { type: 'Elevation of privilege' }), threat('D', { type: 'spoofing' })),
    );
    expect(result?.threats.map((item) => [item.title, item.description, item.category])).toEqual([
      ['A', 'A text', 'Information Disclosure'],
      ['B', 'B text', 'Denial of Service'],
      ['C', 'C text', 'Elevation of Privilege'],
      ['D', 'D text', 'Spoofing'],
    ]);
  });

  it.each([
    ['High', 'High'],
    ['medium', 'Medium'],
    ['LOW', 'Low'],
  ])('takes the severity %s as the impact %s, with Medium likelihood', (severity, impact) => {
    const made = threatsOf(withThreats(threat('A', { severity })))?.threats[0];
    expect([made?.impact, made?.likelihood]).toEqual([impact, 'Medium']);
  });

  it('takes any other severity as Medium impact, naming TBA when it is that', () => {
    const result = file([diagram(withThreats(threat('A', { severity: 'TBA' }), threat('B', { severity: 'Severe' })))]);
    expect(model0(result)?.threats.map((item) => item.impact)).toEqual(['Medium', 'Medium']);
    expect(notesOf(result)).toEqual([
      { path: 'file.detail.diagrams.0.cells.0.data.threats.0', kind: 'mapped.severity', label: 'A', detail: 'TBA' },
      { path: 'file.detail.diagrams.0.cells.0.data.threats.1', kind: 'mapped.severity', label: 'B', detail: 'other' },
    ]);
  });

  it.each([
    ['Open', 'open'],
    ['Mitigated', 'mitigated'],
    ['Accepted', 'accepted'],
    ['NA', 'not_applicable'],
    ['N/A', 'not_applicable'],
    ['NotApplicable', 'not_applicable'],
  ])('reads the status %s as %s, with no note', (status, expected) => {
    const result = file([diagram(withThreats(threat('A', { status })))]);
    expect(model0(result)?.threats[0]?.status).toBe(expected);
    expect(notesOf(result)).toEqual([]);
  });

  it('reads a status Scrylux has no equivalent for as open, naming it', () => {
    const result = file([diagram(withThreats(threat('A', { status: 'Transferred' }), threat('B', { status: 'Eliminated' }), threat('C', { status: 'Whatever' })))]);
    expect(model0(result)?.threats.map((item) => item.status)).toEqual(['open', 'open', 'open']);
    expect(notesOf(result).map((item) => [item.kind, item.label, item.detail])).toEqual([
      ['mapped.status', 'A', 'Transferred'],
      ['mapped.status', 'B', 'Eliminated'],
      ['mapped.status', 'C', 'other'],
    ]);
  });

  it('makes a mitigation of a non-empty mitigation text: implemented for a Mitigated threat, proposed otherwise', () => {
    const result = threatsOf(withThreats(threat('A', { status: 'Mitigated', mitigation: 'Fix it' }), threat('B', { status: 'Open', mitigation: '  Plan it ' }), threat('C', { mitigation: '   ' }), threat('D', { status: 'Mitigated' })));
    expect(result?.mitigations.map((item) => [item.description, item.status])).toEqual([['Fix it', 'implemented'], ['Plan it', 'proposed']]);
    expect(result?.mitigations[0]?.threat_id).toBe(result?.threats[0]?.id);
  });

  it('keeps an imported decision as it is: Mitigated with no mitigation, and Accepted with no reason', () => {
    const result = threatsOf(withThreats(threat('A', { status: 'Mitigated' }), threat('B', { status: 'Accepted' })));
    expect(result?.threats.map((item) => [item.status, item.status_reason])).toEqual([['mitigated', null], ['accepted', null]]);
  });

  it('is always manual, and notes a score', () => {
    const result = file([diagram(withThreats(threat('A', { score: '7', number: 3, threatId: 'x', modelType: 'STRIDE' })))]);
    expect(model0(result)?.threats[0]).toMatchObject({ origin: 'manual', library_ref: null, stale: null });
    expect(notesOf(result)).toEqual([{ path: 'file.detail.diagrams.0.cells.0.data.threats.0', kind: 'not_imported.field', label: 'A', detail: 'score' }]);
  });

  it('puts a threat on a cell that was not carried over on the model, with a note', () => {
    const result = file([diagram([node('a', 'actor', 0, 0), cell('line', 'trust-boundary-curve', { name: 'Perimeter', threats: [threat('On the line')] }), flow('loose', 'a', null, { name: 'Loose', threats: [threat('On a loose flow')] })])]);
    expect(model0(result)?.threats.map((item) => [item.title, item.element_id])).toEqual([['On the line', null], ['On a loose flow', null]]);
    expect(notesOf(result).filter((item) => item.kind === 'moved.model_level').map((item) => item.label)).toEqual(['On the line', 'On a loose flow']);
  });

  it('leaves out the threats of a diagram that is not STRIDE, and one with no STRIDE category, with a note each', () => {
    const cia = file([diagram(withThreats(threat('A'), threat('B')), { diagramType: 'CIA' })]);
    expect(model0(cia)?.threats).toEqual([]);
    expect(model0(cia)?.elements).toHaveLength(1);
    expect(notesOf(cia).map((item) => [item.kind, item.label])).toEqual([['not_imported.threat_category', 'A'], ['not_imported.threat_category', 'B']]);
    const odd = file([diagram(withThreats(threat('A', { type: 'Linkability' })))]);
    expect(model0(odd)?.threats).toEqual([]);
    expect(notesOf(odd)).toEqual([{ path: 'file.detail.diagrams.0.cells.0.data.threats.0', kind: 'not_imported.threat_category', label: 'A' }]);
  });
});

describe('models', () => {
  it('makes one model per diagram, named after the file and the diagram, as a draft of STRIDE', () => {
    const result = file([diagram([node('a', 'actor', 0, 0)], { title: 'Web' }), diagram([node('b', 'process', 0, 0)], { title: 'Batch' })], { title: 'Shop' });
    const models = checked(result).models;
    expect(models.map((model) => [model.threatModel.name, model.threatModel.status, model.threatModel.methodology])).toEqual([['Shop – Web', 'draft', 'STRIDE'], ['Shop – Batch', 'draft', 'STRIDE']]);
    expect(models.map((model) => model.elements.length)).toEqual([1, 1]);
  });

  it('names a model of a one-diagram file after the file alone', () => {
    expect(model0(file([diagram([], { title: 'Web' })], { title: 'Shop' }))?.threatModel.name).toBe('Shop');
  });

  it('leaves a name empty when the file has no title, for the user to fill in', () => {
    const result = file([diagram([], { title: undefined })], {});
    expect(model0(result)?.name_issue).toBe('empty');
    expect(checked(file([diagram([], { title: 'A' }), diagram([], { title: 'A' })], { title: 'Same' })).models.map((model) => model.name_issue)).toEqual(['duplicate', 'duplicate']);
  });

  it('notes file-level content once, on the first model, and a diagram’s own description', () => {
    const result = file([diagram([], { title: 'A', description: 'About A' }), diagram([], { title: 'B' })], { title: 'Shop', description: 'D', owner: 'O' });
    const raw = { ...result, detail: { ...(result.detail as Obj), contributors: [{ name: 'Ada' }] } };
    expect(notesOf(raw).map((item) => [item.path, item.detail])).toEqual([
      ['file.summary', 'description'],
      ['file.summary', 'owner'],
      ['file.detail', 'contributors'],
      ['file.detail.diagrams.0', 'description'],
    ]);
  });

  it('refuses a Threat Dragon version 1 file, and a file that is not Threat Dragon, naming what it reads', () => {
    const v1 = { version: '1.0', detail: { diagrams: [{ diagramJson: {} }] } };
    expect(refusal(() => parseFile('threat-dragon', v1)).message).toBe('file: Threat Dragon version 1 files are not supported; open and save the model in Threat Dragon 2 first');
    expect(refusal(() => parseFile('threat-dragon', { hello: 1 })).message).toBe('file: not a Threat Dragon version 2 file');
    expect(refusal(() => parseFile('threat-dragon', { version: '3.0.0', detail: { diagrams: [{ cells: [] }] } })).message).toBe('file: not a Threat Dragon version 2 file');
  });
});

// Recorded from each file, and checked against it by hand: the cells Scrylux keeps, and what it lists. `iot-device` has
// one actor, nine processes, fourteen flows and one store (25 elements), a boundary line and a text block. The CIA and
// LINDDUN demos import their diagrams and list their threats.
const RECORDED: Record<string, { elements: number; threats: number; mitigations: number; notes: Record<string, number> }> = {
  'cryptocurrency-wallet.json': { elements: 33, threats: 0, mitigations: 0, notes: { 'not_imported.field': 13, 'adjusted.unnamed': 10, 'not_imported.text_block': 1, 'not_imported.threat_category': 1, 'not_imported.boundary_line': 1 } },
  'generic-cms.json': { elements: 11, threats: 0, mitigations: 0, notes: { 'not_imported.field': 4, 'not_imported.text_block': 1, 'adjusted.unnamed': 1 } },
  'iot-device.json': { elements: 25, threats: 4, mitigations: 4, notes: { 'not_imported.field': 8, 'not_imported.text_block': 1, 'adjusted.unnamed': 8, 'not_imported.boundary_line': 1, 'mapped.severity': 1 } },
  'online-game.json': { elements: 32, threats: 0, mitigations: 0, notes: { 'not_imported.field': 3, 'not_imported.text_block': 1, 'adjusted.unnamed': 13 } },
  'payment-online.json': { elements: 18, threats: 0, mitigations: 0, notes: { 'not_imported.field': 5, 'not_imported.text_block': 1 } },
  'renting-car.json': { elements: 33, threats: 0, mitigations: 0, notes: { 'not_imported.field': 4, 'adjusted.unnamed': 7, 'not_imported.text_block': 1 } },
  'three-tier-web-app.json': { elements: 8, threats: 2, mitigations: 2, notes: { 'not_imported.field': 5, 'adjusted.unnamed': 5, 'not_imported.text_block': 1 } },
  'v2-threat-model.json': { elements: 16, threats: 14, mitigations: 14, notes: { 'not_imported.field': 8, 'not_imported.boundary_line': 3, 'not_imported.dangling_flow': 1, 'moved.model_level': 1, 'not_imported.text_block': 1 } },
};

describe('the demo models (SC-003)', () => {
  it('records every demo file there is', () => {
    expect(Object.keys(RECORDED).sort()).toEqual(readdirSync(dir).sort());
  });

  it.each(Object.entries(RECORDED))('imports %s as recorded, with every note of a known kind and place', (name, recorded) => {
    const result = checked(demo(name));
    expect(result.models).toHaveLength(1);
    const model = result.models[0];
    expect(model?.name_issue).toBeNull();
    expect([model?.elements.length, model?.threats.length, model?.mitigations.length]).toEqual([recorded.elements, recorded.threats, recorded.mitigations]);
    const counts: Record<string, number> = {};
    for (const item of result.notes) {
      expect(NOTE_KINDS).toContain(item.kind);
      expect(item.path).toMatch(/^file(\.[A-Za-z]+|\.\d+)*$/);
      counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    }
    expect(counts).toEqual(recorded.notes);
    expect(summarize(result).models[0]?.elements).toBe(recorded.elements);
  });

  it('puts the nodes of a diagram in the trust boundary box drawn around them (online-game)', () => {
    const model = checked(demo('online-game.json')).models[0];
    const boundaries = model?.elements.filter((element) => element.type === 'trust_boundary') ?? [];
    expect(boundaries).toHaveLength(3);
    const inside = model?.elements.filter((element) => element.parent_boundary_id !== null) ?? [];
    expect(inside.length).toBeGreaterThan(0);
    for (const element of inside) expect(boundaries.map((boundary) => boundary.id)).toContain(element.parent_boundary_id);
  });
});
