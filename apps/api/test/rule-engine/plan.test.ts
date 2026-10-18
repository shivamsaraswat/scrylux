import type { StaleReason } from '@scrylux/core';
import { shippedLibrary } from '@scrylux/threat-library';
import { describe, expect, it } from 'vitest';
import { planGeneration, type ExistingRuleThreat } from '../../src/rule-engine/plan.js';
import { counterIds, element, flow, libraryOf, rule } from './fixtures.js';

const crossing = { crosses_trust_boundary: 'yes', source_type: 'external_entity', target_type: 'process' };
const internal = { crosses_trust_boundary: 'no', source_type: 'process', target_type: 'process' };

// Every process gets the baseline; an internet-facing one also the tampering rule; a flow that crosses
// a boundary the third.
const library = libraryOf([
  rule({ id: 'p-repudiation-baseline', type: 'process', category: 'Repudiation', applies: {} }),
  rule({
    id: 'p-tampering-exposed',
    type: 'process',
    category: 'Tampering',
    flags: { internet_facing: 'yes' },
    applies: { flags: { internet_facing: 'yes' } },
    doesNotApply: { flags: { internet_facing: 'no' } },
  }),
  rule({
    id: 'df-tampering-crossing',
    type: 'data_flow',
    category: 'Tampering',
    flow: { crosses_trust_boundary: 'yes' },
    applies: { flow: crossing },
    doesNotApply: { flow: internal },
  }),
]);

const plan = (elements: ReturnType<typeof element>[], ruleThreats: Parameters<typeof planGeneration>[0]['ruleThreats'] = []) =>
  planGeneration({ elements, ruleThreats, library, newId: counterIds() });

describe('planGeneration: creating threats (US1)', () => {
  it('plans one threat per candidate, across every element', () => {
    const exposed = element({ type: 'process', properties: { flags: { internet_facing: true } } });
    const plain = element({ type: 'process' });
    const result = plan([exposed, plain]);
    expect(result.creates.map((c) => [c.element_id, c.library_ref]).sort()).toEqual(
      [
        [exposed.id, 'p-repudiation-baseline'],
        [exposed.id, 'p-tampering-exposed'],
        [plain.id, 'p-repudiation-baseline'],
      ].sort(),
    );
  });

  it('gives each threat the candidate fields, an open status, origin rule and its rule id', () => {
    const p = element({ type: 'process', name: 'Orders API' });
    const [created] = plan([p]).creates;
    expect(created).toMatchObject({
      element_id: p.id,
      category: 'Repudiation',
      title: 'Title of p-repudiation-baseline on Orders API',
      description: 'Description of p-repudiation-baseline for Orders API.',
      likelihood: 'Medium',
      impact: 'High',
      status: 'open',
      origin: 'rule',
      library_ref: 'p-repudiation-baseline',
    });
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('plans one proposed mitigation per suggested mitigation, tied to its threat and with no ticket', () => {
    const [created] = plan([element({ type: 'process' })]).creates;
    expect(created?.mitigations).toEqual([
      { threat_id: created?.id, description: 'First mitigation of p-repudiation-baseline.', status: 'proposed', external_ref: null },
      { threat_id: created?.id, description: 'Second mitigation of p-repudiation-baseline.', status: 'proposed', external_ref: null },
    ]);
  });

  it('counts what it creates and nothing else, and plans no stale change', () => {
    const result = plan([element({ type: 'process' }), element({ type: 'process' })]);
    expect(result.counts).toEqual({ created: 2, existing: 0, newly_stale: 0, no_longer_stale: 0, skipped_elements: [] });
    expect(result.staleChanges).toEqual([]);
  });

  it('plans nothing for trust boundaries, or for a diagram with none of the elements a rule covers', () => {
    expect(plan([element({ type: 'trust_boundary' })]).creates).toEqual([]);
    expect(plan([]).counts.created).toBe(0);
  });

  it('hands a data flow its flow context: only the flow that crosses a boundary gets the crossing rule', () => {
    const boundary = element({ type: 'trust_boundary' });
    const outside = element({ type: 'external_entity' });
    const inside = element({ type: 'process', parent_boundary_id: boundary.id });
    const alsoInside = element({ type: 'process', parent_boundary_id: boundary.id });
    const crossingFlow = flow(outside, inside);
    const internalFlow = flow(inside, alsoInside);
    const result = plan([boundary, outside, inside, alsoInside, crossingFlow, internalFlow]);
    const forFlows = result.creates.filter((c) => c.library_ref === 'df-tampering-crossing');
    expect(forFlows.map((c) => c.element_id)).toEqual([crossingFlow.id]);
  });

  it('plans the same for the shipped library as the library itself returns', () => {
    const shipped = shippedLibrary();
    const p = element({ type: 'process', name: 'Orders API' });
    const expected = shipped.candidatesFor({ type: 'process', name: 'Orders API', properties: {} });
    const result = planGeneration({ elements: [p], ruleThreats: [], library: shipped, newId: counterIds() });
    expect(result.creates.map((c) => c.library_ref)).toEqual(expected.map((c) => c.rule_id));
    expect(result.counts.created).toBe(expected.length);
  });
});

describe('planGeneration: elements stored with old properties (FR-002a)', () => {
  it('skips an element whose properties fall outside the vocabulary, and still plans the rest', () => {
    const old = element({ type: 'process', properties: { flags: { legacy_flag: true } } });
    const unknownKey = element({ type: 'process', properties: { colour: 'red' } });
    const fine = element({ type: 'process' });
    const result = plan([old, unknownKey, fine]);
    expect(result.creates.every((c) => c.element_id === fine.id)).toBe(true);
    expect(result.counts.skipped_elements).toEqual([old.id, unknownKey.id].sort());
    expect(result.counts.created).toBe(1);
  });

  it('lists skipped ids sorted and unique, and none when nothing is skipped', () => {
    expect(plan([element({ type: 'process' })]).counts.skipped_elements).toEqual([]);
  });
});

// ---- US2: matching what already exists (FR-006 to FR-008) ----

// What a first run stored, as the planner will see it on the next run.
const stored = (creates: ReturnType<typeof plan>['creates']): ExistingRuleThreat[] =>
  creates.map(({ id, element_id, library_ref }) => ({ id, element_id, library_ref, stale: null }));

describe('planGeneration: matching existing threats (US2)', () => {
  const exposed = element({ type: 'process', name: 'Exposed', properties: { flags: { internet_facing: true } } });
  const plain = element({ type: 'process', name: 'Plain' });

  it('plans nothing on an unchanged diagram, and counts every candidate as existing (FR-008)', () => {
    const first = plan([exposed, plain]);
    const second = plan([exposed, plain], stored(first.creates));
    expect(second.creates).toEqual([]);
    expect(second.staleChanges).toEqual([]);
    expect(second.counts).toEqual({ created: 0, existing: first.counts.created, newly_stale: 0, no_longer_stale: 0, skipped_elements: [] });
  });

  it('plans the one threat again when it was deleted (Clarifications Q3)', () => {
    const first = plan([exposed, plain]);
    const [removed, ...kept] = first.creates;
    const second = plan([exposed, plain], stored(kept));
    expect(second.creates.map((c) => [c.element_id, c.library_ref])).toEqual([[removed?.element_id, removed?.library_ref]]);
  });

  it('plans only the new element’s threats when an element was added', () => {
    const first = plan([exposed, plain]);
    const added = element({ type: 'process', name: 'Added' });
    const second = plan([exposed, plain, added], stored(first.creates));
    expect(second.creates.map((c) => c.element_id)).toEqual([added.id]);
    expect(second.counts.existing).toBe(first.counts.created);
  });

  it('plans only the rule a changed flag now triggers, and leaves the element’s other threats alone', () => {
    const first = plan([plain]);
    const nowExposed = { ...plain, properties: { flags: { internet_facing: true } } };
    const second = plan([nowExposed], stored(first.creates));
    expect(second.creates.map((c) => c.library_ref)).toEqual(['p-tampering-exposed']);
    expect(second.counts.existing).toBe(1);
  });

  it('matches on element and rule alone: a threat of the same rule on another element is not a match', () => {
    const first = plan([plain]);
    const other = element({ type: 'process', name: 'Other' });
    const second = plan([plain, other], stored(first.creates));
    expect(second.creates.map((c) => c.element_id)).toEqual([other.id]);
  });
});

// ---- US3: threats that no longer fit the diagram (FR-011, FR-012) ----

describe('planGeneration: stale threats (US3)', () => {
  const internalCtx = { crosses_trust_boundary: 'no', source_type: 'process', target_type: 'process' };
  const rules = libraryOf(
    [
      rule({ id: 'p-tampering-exposed', type: 'process', category: 'Tampering', flags: { internet_facing: 'yes' }, applies: { flags: { internet_facing: 'yes' } }, doesNotApply: { flags: { internet_facing: 'no' } } }),
      rule({ id: 'p-spoofing-high', type: 'process', category: 'Spoofing', flags: { runs_privileged: 'yes' }, variant_group: 'privilege', applies: { flags: { runs_privileged: 'yes' } }, doesNotApply: { flags: { runs_privileged: 'no' } } }),
      rule({ id: 'p-spoofing-low', type: 'process', category: 'Spoofing', flags: { runs_privileged: 'no' }, variant_group: 'privilege', applies: { flags: { runs_privileged: 'no' } }, doesNotApply: { flags: { runs_privileged: 'yes' } } }),
      rule({ id: 'p-repudiation-baseline', type: 'process', category: 'Repudiation', applies: {} }),
      rule({ id: 'ds-repudiation-baseline', type: 'data_store', category: 'Repudiation', applies: {} }),
      rule({
        id: 'df-tampering-plaintext',
        type: 'data_flow',
        category: 'Tampering',
        flags: { encrypted_in_transit: 'no' },
        applies: { flags: { encrypted_in_transit: 'no' }, flow: internalCtx },
        doesNotApply: { flags: { encrypted_in_transit: 'yes' }, flow: internalCtx },
      }),
      rule({ id: 'df-tampering-crossing', type: 'data_flow', category: 'Tampering', flow: { crosses_trust_boundary: 'yes' }, applies: { flow: crossing }, doesNotApply: { flow: internalCtx } }),
    ],
    [{ id: 'p-old-rule', retired_on: '2026-11-02', reason: 'Split into two rules.', replaced_by: ['p-repudiation-baseline'] }],
  );

  const run = (elements: ReturnType<typeof element>[], ruleThreats: ExistingRuleThreat[]) =>
    planGeneration({ elements, ruleThreats, library: rules, newId: counterIds() });
  let n = 0;
  const threat = (elementId: string, ref: string, stale: ExistingRuleThreat['stale'] = null): ExistingRuleThreat => ({
    id: `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    element_id: elementId,
    library_ref: ref,
    stale,
  });
  // The stored threats a diagram would have had on its first run, for the rules named.
  const flagReason = (flag: string, required: 'yes' | 'no', actual: 'yes' | 'no' | 'not_assessed'): StaleReason => ({
    reason: 'conditions_unmet',
    unmet: [{ fact: 'flag', flag, required, actual }],
  });

  it('flags a threat stale when a flag now makes its rule not apply, naming the condition', () => {
    const p = element({ type: 'process', properties: { flags: { internet_facing: false } } });
    const t = threat(p.id, 'p-tampering-exposed');
    const result = run([p], [t]);
    expect(result.staleChanges).toEqual([{ id: t.id, stale: flagReason('internet_facing', 'yes', 'no') }]);
    expect(result.counts).toMatchObject({ newly_stale: 1, no_longer_stale: 0 });
  });

  it('names a flag that was never assessed as "not assessed"', () => {
    const p = element({ type: 'process' });
    const t = threat(p.id, 'p-tampering-exposed');
    expect(run([p], [t]).staleChanges[0]?.stale).toEqual(flagReason('internet_facing', 'yes', 'not_assessed'));
  });

  it('clears the marker when the rule applies again, and counts the threat as existing and no longer stale', () => {
    const p = element({ type: 'process', properties: { flags: { internet_facing: true } } });
    const t = threat(p.id, 'p-tampering-exposed', flagReason('internet_facing', 'yes', 'no'));
    const result = run([p], [t]);
    expect(result.staleChanges).toEqual([{ id: t.id, stale: null }]);
    expect(result.creates.filter((c) => c.library_ref === 'p-tampering-exposed')).toEqual([]);
    expect(result.counts).toMatchObject({ newly_stale: 0, no_longer_stale: 1 });
  });

  it('writes nothing when the stored reason is the same, however its keys are ordered', () => {
    const p = element({ type: 'process', properties: { flags: { internet_facing: false } } });
    const reordered = { unmet: [{ actual: 'no', required: 'yes', flag: 'internet_facing', fact: 'flag' }], reason: 'conditions_unmet' } as unknown as ExistingRuleThreat['stale'];
    const result = run([p], [threat(p.id, 'p-tampering-exposed', reordered)]);
    expect(result.staleChanges).toEqual([]);
    expect(result.counts).toMatchObject({ newly_stale: 0, no_longer_stale: 0 });
  });

  it('replaces a different stored reason without counting it as newly stale', () => {
    const p = element({ type: 'process', properties: { flags: { internet_facing: false } } });
    const t = threat(p.id, 'p-tampering-exposed', flagReason('internet_facing', 'yes', 'not_assessed'));
    const result = run([p], [t]);
    expect(result.staleChanges).toEqual([{ id: t.id, stale: flagReason('internet_facing', 'yes', 'no') }]);
    expect(result.counts).toMatchObject({ newly_stale: 0, no_longer_stale: 0 });
  });

  it('reports only the element type when a node changed type, and creates the new type’s threats', () => {
    const now = element({ type: 'data_store', name: 'Was a process' });
    const t = threat(now.id, 'p-tampering-exposed');
    const result = run([now], [t]);
    expect(result.staleChanges).toEqual([{ id: t.id, stale: { reason: 'conditions_unmet', unmet: [{ fact: 'element_type', required: 'process', actual: 'data_store' }] } }]);
    expect(result.creates.map((c) => c.library_ref)).toEqual(['ds-repudiation-baseline']);
  });

  it('flags a crossing-only threat stale when a node moved so the flow no longer crosses', () => {
    const boundary = element({ type: 'trust_boundary' });
    const a = element({ type: 'process', parent_boundary_id: boundary.id });
    const b = element({ type: 'process', parent_boundary_id: boundary.id });
    const f = flow(a, b);
    const t = threat(f.id, 'df-tampering-crossing');
    expect(run([boundary, a, b, f], [t]).staleChanges).toEqual([
      { id: t.id, stale: { reason: 'conditions_unmet', unmet: [{ fact: 'crosses_trust_boundary', required: 'yes', actual: 'no' }] } },
    ]);
  });

  it('switches between two versions of one threat: the old one goes stale and the new one is created', () => {
    const p = element({ type: 'process', properties: { flags: { runs_privileged: true } } });
    const old = threat(p.id, 'p-spoofing-low');
    const result = run([p], [old]);
    expect(result.staleChanges.map((c) => c.id)).toEqual([old.id]);
    expect(result.creates.map((c) => c.library_ref)).toContain('p-spoofing-high');
    expect(result.creates.map((c) => c.library_ref)).not.toContain('p-spoofing-low');
  });

  it('flags a retired rule’s threat with the retirement, and creates a replacement that applies', () => {
    const p = element({ type: 'process' });
    const t = threat(p.id, 'p-old-rule');
    const result = run([p], [t]);
    expect(result.staleChanges).toEqual([
      { id: t.id, stale: { reason: 'rule_retired', retired_on: '2026-11-02', retirement_reason: 'Split into two rules.', replaced_by: ['p-repudiation-baseline'] } },
    ]);
    expect(result.creates.map((c) => c.library_ref)).toContain('p-repudiation-baseline');
  });

  it('flags a rule the library has never heard of', () => {
    const p = element({ type: 'process' });
    const t = threat(p.id, 'p-never-existed');
    expect(run([p], [t]).staleChanges).toEqual([{ id: t.id, stale: { reason: 'rule_unknown' } }]);
  });

  it('leaves a threat on a skipped element alone: neither changed nor counted', () => {
    const old = element({ type: 'process', properties: { flags: { legacy_flag: true } } });
    const t = threat(old.id, 'p-tampering-exposed');
    const result = run([old], [t]);
    expect(result.staleChanges).toEqual([]);
    expect(result.counts).toMatchObject({ newly_stale: 0, existing: 0, skipped_elements: [old.id] });
  });

  it('fails, instead of guessing, when a stored threat’s element is not in the diagram', () => {
    expect(() => run([], [threat('20000000-0000-4000-8000-000000000001', 'p-tampering-exposed')])).toThrow();
  });
});
