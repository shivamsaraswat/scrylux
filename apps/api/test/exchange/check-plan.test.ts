import { describe, expect, it } from 'vitest';
import {
  checkPlan,
  requireUsableNames,
  summarize,
  type ImportPlan,
  type PlanAsset,
  type PlanAssumption,
  type PlanElement,
  type PlanMitigation,
  type PlanThreat,
} from '../../src/exchange/import/plan.js';
import { HttpError } from '../../src/v1/errors.js';

// The rules across records, applied before anything is written (research #9): every storage rule is refused here with
// the place in the file, so the writer cannot fail on content.

const element = (id: string, type: PlanElement['type'], extra: Partial<PlanElement> = {}): PlanElement => ({
  id,
  path: 'file.elements.0',
  type,
  name: id,
  properties: {},
  layout: null,
  parent_boundary_id: null,
  source_element_id: null,
  target_element_id: null,
  depth: 0,
  ...extra,
});

const threat = (id: string, element_id: string | null, extra: Partial<PlanThreat> = {}): PlanThreat => ({
  id,
  path: 'file.threats.0',
  element_id,
  category: 'Spoofing',
  title: id,
  description: '',
  likelihood: 'Medium',
  impact: 'High',
  status: 'open',
  status_reason: null,
  origin: 'manual',
  library_ref: null,
  stale: null,
  ...extra,
});

const mitigation = (id: string, threat_id: string, extra: Partial<PlanMitigation> = {}): PlanMitigation => ({
  id,
  path: 'file.mitigations.0',
  threat_id,
  description: id,
  status: 'proposed',
  external_ref: null,
  ...extra,
});

// Gives each row the path its index in the file would have, so a message names the right place.
function plan(
  elements: PlanElement[],
  threats: PlanThreat[] = [],
  mitigations: PlanMitigation[] = [],
  name = 'Model',
  assets: PlanAsset[] = [],
  assumptions: PlanAssumption[] = [],
): ImportPlan {
  return {
    models: [
      {
        threatModel: { id: 'model', name, methodology: 'STRIDE', status: 'draft' },
        name_issue: null,
        elements: elements.map((item, index) => ({ ...item, path: `file.elements.${index}` })),
        threats: threats.map((item, index) => ({ ...item, path: `file.threats.${index}` })),
        mitigations: mitigations.map((item, index) => ({ ...item, path: `file.mitigations.${index}` })),
        assets: assets.map((item, index) => ({ ...item, path: `file.assets.${index}` })),
        assumptions: assumptions.map((item, index) => ({ ...item, path: `file.assumptions.${index}` })),
      },
    ],
    notes: [],
  };
}

const check = (value: ImportPlan, existingNames: string[] = [], names?: string[]) => checkPlan(value, { names, existingNames });

function refusal(run: () => unknown): HttpError {
  try {
    run();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('checkPlan on a valid plan', () => {
  const valid = plan(
    [
      element('b1', 'trust_boundary'),
      element('b2', 'trust_boundary', { parent_boundary_id: 'b1' }),
      element('p1', 'process', { parent_boundary_id: 'b2' }),
      element('d1', 'data_store'),
      element('f1', 'data_flow', { source_element_id: 'p1', target_element_id: 'd1' }),
    ],
    [threat('t1', 'p1', { origin: 'rule', library_ref: 'r1', stale: { reason: 'rule_unknown' } }), threat('t2', null)],
    [mitigation('m1', 't1')],
  );

  it('gives every record a new id and remaps every reference', () => {
    const checked = check(valid).models[0];
    const ids = new Map(checked?.elements.map((item, index) => [valid.models[0]?.elements[index]?.id, item.id]));
    for (const item of checked?.elements ?? []) expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    const flow = checked?.elements[4];
    expect(flow?.source_element_id).toBe(ids.get('p1'));
    expect(flow?.target_element_id).toBe(ids.get('d1'));
    expect(checked?.elements[2]?.parent_boundary_id).toBe(ids.get('b2'));
    expect(checked?.threats[0]?.element_id).toBe(ids.get('p1'));
    expect(checked?.threats[1]?.element_id).toBeNull();
    expect(checked?.mitigations[0]?.threat_id).toBe(checked?.threats[0]?.id);
    expect(new Set([...(checked?.elements ?? []), ...(checked?.threats ?? []), ...(checked?.mitigations ?? [])].map((item) => item.id)).size).toBe(8);
  });

  it('sets the nesting depth of each trust boundary', () => {
    const depths = check(valid).models[0]?.elements.map((item) => item.depth);
    expect(depths).toEqual([0, 1, 0, 0, 0]);
  });

  it('does not change its input', () => {
    const before = JSON.stringify(valid);
    check(valid);
    expect(JSON.stringify(valid)).toBe(before);
  });
});

describe('checkPlan refuses, naming the place and the rule (research #9)', () => {
  it.each<[string, () => ImportPlan, string]>([
    [
      'an id repeated',
      () => plan([element('a', 'process'), element('a', 'process')]),
      'file.elements.1.id: must be different from every other id in the file',
    ],
    [
      'an id shared by an element and a threat',
      () => plan([element('a', 'process')], [threat('a', null)]),
      'file.threats.0.id: must be different from every other id in the file',
    ],
    [
      'a parent that is missing',
      () => plan([element('p', 'process', { parent_boundary_id: 'nope' })]),
      'file.elements.0.parent_boundary_id: must refer to a trust boundary in this file',
    ],
    [
      'a parent that is not a trust boundary',
      () => plan([element('a', 'process'), element('p', 'process', { parent_boundary_id: 'a' })]),
      'file.elements.1.parent_boundary_id: must refer to a trust boundary in this file',
    ],
    [
      'a flow end that is missing',
      () => plan([element('a', 'process'), element('f', 'data_flow', { source_element_id: 'a', target_element_id: 'nope' })]),
      'file.elements.1.target_element_id: must refer to an external entity, process or data store in this file',
    ],
    [
      'a flow end that is a trust boundary',
      () => plan([element('a', 'process'), element('b', 'trust_boundary'), element('f', 'data_flow', { source_element_id: 'a', target_element_id: 'b' })]),
      'file.elements.2.target_element_id: must refer to an external entity, process or data store in this file',
    ],
    [
      'a flow end that is a flow',
      () =>
        plan([
          element('a', 'process'),
          element('f1', 'data_flow', { source_element_id: 'a', target_element_id: 'a2' }),
          element('a2', 'process'),
          element('f2', 'data_flow', { source_element_id: 'a', target_element_id: 'f1' }),
        ]),
      'file.elements.3.target_element_id: must refer to an external entity, process or data store in this file',
    ],
    [
      'a flow from an element to itself',
      () => plan([element('a', 'process'), element('f', 'data_flow', { source_element_id: 'a', target_element_id: 'a' })]),
      'file.elements.1: a data flow cannot start and end at the same element',
    ],
    [
      'a flow with a parent',
      () => plan([element('b', 'trust_boundary'), element('a', 'process'), element('f', 'data_flow', { source_element_id: 'a', target_element_id: 'a2', parent_boundary_id: 'b' }), element('a2', 'process')]),
      'file.elements.2.parent_boundary_id: a data flow cannot have a parent_boundary_id',
    ],
    [
      'a flow with no ends',
      () => plan([element('f', 'data_flow')]),
      'file.elements.0: a data flow needs source_element_id and target_element_id, and other element types must have neither',
    ],
    [
      'a process with flow ends',
      () => plan([element('a', 'process'), element('p', 'process', { source_element_id: 'a', target_element_id: 'a' })]),
      'file.elements.1: a data flow needs source_element_id and target_element_id, and other element types must have neither',
    ],
    [
      'a boundary cycle',
      () => plan([element('a', 'trust_boundary', { parent_boundary_id: 'b' }), element('b', 'trust_boundary', { parent_boundary_id: 'a' })]),
      'file.elements.0.parent_boundary_id: trust boundaries cannot contain each other in a cycle',
    ],
    [
      'a boundary that is its own parent',
      () => plan([element('a', 'trust_boundary', { parent_boundary_id: 'a' })]),
      'file.elements.0.parent_boundary_id: trust boundaries cannot contain each other in a cycle',
    ],
    [
      'a threat on a missing element',
      () => plan([element('a', 'process')], [threat('t', 'nope')]),
      'file.threats.0.element_id: must refer to an element in this file',
    ],
    [
      'a reason on an open threat',
      () => plan([], [threat('t', null, { status: 'open', status_reason: 'why' })]),
      'file.threats.0.status_reason: can only be set on a threat that is accepted or not_applicable',
    ],
    [
      'a reason on a mitigated threat',
      () => plan([], [threat('t', null, { status: 'mitigated', status_reason: 'why' })]),
      'file.threats.0.status_reason: can only be set on a threat that is accepted or not_applicable',
    ],
    [
      'stale on a manual threat',
      () => plan([], [threat('t', null, { stale: { reason: 'rule_unknown' } })]),
      'file.threats.0.stale: can only be set on a rule-generated threat',
    ],
    [
      'a rule threat with no element',
      () => plan([], [threat('t', null, { origin: 'rule', library_ref: 'r' })]),
      'file.threats.0.element_id: a rule-generated threat needs an element',
    ],
    [
      'a rule threat with no rule',
      () => plan([element('a', 'process')], [threat('t', 'a', { origin: 'rule' })]),
      'file.threats.0.library_ref: a rule-generated threat needs a library_ref',
    ],
    [
      'two rule threats from one rule on one element',
      () => plan([element('a', 'process')], [threat('t1', 'a', { origin: 'rule', library_ref: 'r' }), threat('t2', 'a', { origin: 'rule', library_ref: 'r' })]),
      'file.threats.1: another rule-generated threat already has this element and rule',
    ],
    [
      'a mitigation of a missing threat',
      () => plan([], [threat('t', null)], [mitigation('m', 'nope')]),
      'file.mitigations.0.threat_id: must refer to a threat in this file',
    ],
  ])('%s', (_label, build, message) => {
    const err = refusal(() => check(build()));
    expect(err.status).toBe(400);
    expect(err.message).toBe(message);
  });

  it('refuses 1,001 elements and allows 1,000', () => {
    const many = (count: number) => plan(Array.from({ length: count }, (_unused, index) => element(`p${index}`, 'process')));
    expect(() => check(many(1000))).not.toThrow();
    expect(refusal(() => check(many(1001))).message).toBe('file: a threat model can hold at most 1,000 elements');
  });

  it('allows two rule threats from one rule on different elements, and the same rule as a manual threat', () => {
    const ok = plan(
      [element('a', 'process'), element('b', 'process')],
      [threat('t1', 'a', { origin: 'rule', library_ref: 'r' }), threat('t2', 'b', { origin: 'rule', library_ref: 'r' }), threat('t3', 'a', { library_ref: 'r' })],
    );
    expect(() => check(ok)).not.toThrow();
  });

  it('never repeats a value from the file in its message', () => {
    const secret = 'secret-value-123';
    const err = refusal(() => check(plan([element(secret, 'process', { parent_boundary_id: secret })])));
    expect(err.message).not.toContain(secret);
  });
});

describe('checkPlan accepts what the lifecycle rules would refuse (FR-009)', () => {
  it('keeps a mitigated threat with no implemented mitigation, and an accepted or not applicable threat with no reason', () => {
    const lax = plan(
      [],
      [threat('t1', null, { status: 'mitigated' }), threat('t2', null, { status: 'accepted' }), threat('t3', null, { status: 'not_applicable' })],
      [mitigation('m1', 't1', { status: 'proposed' })],
    );
    const checked = check(lax).models[0];
    expect(checked?.threats.map((item) => [item.status, item.status_reason])).toEqual([
      ['mitigated', null],
      ['accepted', null],
      ['not_applicable', null],
    ]);
  });
});

describe('names', () => {
  it('sets each model name_issue from core nameIssues, and never throws for one', () => {
    expect(check(plan([], [], [], 'Checkout'), ['checkout']).models[0]?.name_issue).toBe('taken');
    expect(check(plan([], [], [], '  ')).models[0]?.name_issue).toBe('empty');
    expect(check(plan([], [], [], 'Fresh'), ['Other']).models[0]?.name_issue).toBeNull();
    const two: ImportPlan = { ...plan([]), models: [plan([], [], [], 'Same').models[0] as never, plan([], [], [], 'same').models[0] as never] };
    expect(check(two).models.map((model) => model.name_issue)).toEqual(['duplicate', 'duplicate']);
  });

  it('applies names, in order, over the file defaults', () => {
    const named = check(plan([], [], [], 'Default'), [], ['Copy']);
    expect(named.models[0]?.threatModel.name).toBe('Copy');
  });

  it('refuses a names list of the wrong length', () => {
    expect(refusal(() => check(plan([]), [], ['A', 'B'])).message).toBe('names: must have 1 entry, one per threat model in the file');
    const two: ImportPlan = { ...plan([]), models: [plan([]).models[0] as never, plan([]).models[0] as never] };
    expect(refusal(() => check(two, [], ['A'])).message).toBe('names: must have 2 entries, one per threat model in the file');
  });
});

describe('requireUsableNames', () => {
  it('answers 409 for a taken name, naming names.0 when names were sent and threat_model.name when not', () => {
    const taken = check(plan([], [], [], 'Checkout'), ['Checkout']);
    const withNames = refusal(() => requireUsableNames(taken, true));
    expect(withNames.status).toBe(409);
    expect(withNames.message).toBe('names.0: a threat model with this name already exists in this project');
    const without = refusal(() => requireUsableNames(taken, false));
    expect(without.status).toBe(409);
    expect(without.message).toBe('threat_model.name: a threat model with this name already exists in this project');
  });

  it('answers 400 for the other issues', () => {
    expect(refusal(() => requireUsableNames(check(plan([], [], [], ' ')), true))).toMatchObject({ status: 400, message: 'names.0: must not be empty' });
    expect(refusal(() => requireUsableNames(check(plan([], [], [], 'x'.repeat(201))), true))).toMatchObject({
      status: 400,
      message: 'names.0: must be at most 200 characters',
    });
    const two: ImportPlan = { ...plan([]), models: [plan([], [], [], 'A').models[0] as never, plan([], [], [], 'a').models[0] as never] };
    expect(refusal(() => requireUsableNames(check(two), true))).toMatchObject({
      status: 400,
      message: 'names.0: must differ from the other names in this file',
    });
  });

  it('passes a plan whose names are all usable', () => {
    expect(() => requireUsableNames(check(plan([], [], [], 'Fresh')), false)).not.toThrow();
  });
});

describe('summarize', () => {
  it('counts each model and keeps the notes', () => {
    const base = plan([element('a', 'process')], [threat('t', 'a')], [mitigation('m', 't')], 'Counted');
    const noted: ImportPlan = { ...base, notes: [{ path: 'file.x', kind: 'not_imported.asset', label: 'Asset' }] };
    expect(summarize(check(noted))).toEqual({
      models: [{ name: 'Counted', name_issue: null, status: 'draft', elements: 1, threats: 1, mitigations: 1, assets: 0, assumptions: 0 }],
      notes: [{ path: 'file.x', kind: 'not_imported.asset', label: 'Asset' }],
    });
  });
});

// Assets and assumptions (Phase 3 Milestone 5, FR-021, FR-023): the rules the database enforces are refused here with the place in the file, so the writer
// cannot fail on content.
const asset = (id: string, name: string, holder_ids: string[] = [], extra: Partial<PlanAsset> = {}): PlanAsset => ({ id, path: 'file.assets.0', name, description: `About ${name}.`, holder_ids, ...extra });
const assumption = (id: string, statement: string): PlanAssumption => ({ id, path: 'file.assumptions.0', statement });
const nodes = () => [element('p1', 'process'), element('d1', 'data_store'), element('b1', 'trust_boundary'), element('f1', 'data_flow', { source_element_id: 'p1', target_element_id: 'd1' })];
const withRecords = (assets: PlanAsset[], assumptions: PlanAssumption[] = [], elements: PlanElement[] = nodes()) => plan(elements, [], [], 'Model', assets, assumptions);

describe('checkPlan, assets and assumptions', () => {
  it('gives every asset and assumption a new id and remaps the holders to the new element ids', () => {
    const source = withRecords([asset('a1', 'Tokens', ['p1', 'd1'])], [assumption('s1', 'Nothing is exposed.')]);
    const checked = check(source).models[0];
    const ids = new Map(checked?.elements.map((item, index) => [source.models[0]?.elements[index]?.id, item.id]));
    expect(checked?.assets[0]?.id).not.toBe('a1');
    expect(checked?.assets[0]?.holder_ids).toEqual([ids.get('p1'), ids.get('d1')]);
    expect(checked?.assumptions[0]?.id).not.toBe('s1');
    expect(checked?.assets[0]).toMatchObject({ name: 'Tokens', description: 'About Tokens.' });
  });

  it('refuses a holder that is not an element of the file, or is a data flow or a trust boundary, naming the place', () => {
    const message = (holder: string) => refusal(() => check(withRecords([asset('a1', 'Tokens', [holder])]))).message;
    for (const holder of ['nobody', 'f1', 'b1']) expect(message(holder)).toBe('file.assets.0.holder_ids.0: must refer to an external entity, process or data store in this file');
  });

  it('refuses a holder named twice', () => {
    expect(refusal(() => check(withRecords([asset('a1', 'Tokens', ['p1', 'p1'])]))).message).toBe('file.assets.0.holder_ids: must not repeat an element');
  });

  it('refuses a name or a statement that repeats another’s, ignoring case and surrounding whitespace, at the second one', () => {
    expect(refusal(() => check(withRecords([asset('a1', 'Tokens'), asset('a2', '  TOKENS ')]))).message).toBe('file.assets.1.name: must differ from the name of another asset, ignoring case');
    expect(refusal(() => check(withRecords([], [assumption('s1', 'It is.'), assumption('s2', ' it IS. ')]))).message).toBe(
      'file.assumptions.1.statement: must differ from the statement of another assumption, ignoring case',
    );
  });

  it('refuses an id that another record of the file has', () => {
    expect(refusal(() => check(withRecords([asset('p1', 'Tokens')]))).message).toBe('file.assets.0.id: must be different from every other id in the file');
    expect(refusal(() => check(withRecords([], [assumption('p1', 'It is.')]))).message).toBe('file.assumptions.0.id: must be different from every other id in the file');
  });

  it('refuses more than 200 assets and more than 200 assumptions', () => {
    const many = <T>(make: (n: number) => T): T[] => Array.from({ length: 201 }, (_, n) => make(n));
    expect(refusal(() => check(withRecords(many((n) => asset(`a${n}`, `asset ${n}`))))).message).toBe('file: a threat model can hold at most 200 assets');
    expect(refusal(() => check(withRecords([], many((n) => assumption(`s${n}`, `statement ${n}`))))).message).toBe('file: a threat model can hold at most 200 assumptions');
    expect(check(withRecords(Array.from({ length: 200 }, (_, n) => asset(`a${n}`, `asset ${n}`)))).models[0]?.assets).toHaveLength(200);
  });

  it('counts assets and assumptions in the summary', () => {
    const summary = summarize(check(withRecords([asset('a1', 'Tokens'), asset('a2', 'Notes')], [assumption('s1', 'It is.')])));
    expect(summary.models[0]).toMatchObject({ assets: 2, assumptions: 1 });
  });
});

