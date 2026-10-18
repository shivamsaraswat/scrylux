import { ELEMENT_FLAGS, NODE_TYPES as CORE_NODE_TYPES, RULE_ELEMENT_TYPES as CORE_RULE_ELEMENT_TYPES } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import {
  LibraryInputError,
  NODE_TYPES,
  RULE_ELEMENT_TYPES,
  parseLibrary,
  shippedLibrary,
  type ElementInput,
  type FlowContext,
  type Library,
  type Rule,
} from '../src/index.js';
import { coverageRuleFiles, files, ruleFile } from './helpers.js';

// library.unmetConditions (Phase 2 / Milestone 3, contracts/library-api-additions.md): which of a rule's
// conditions an element does not meet, worked out with the same comparisons as the matcher.

const library = shippedLibrary();

const flowOf = (over: Partial<FlowContext> = {}): FlowContext => ({
  crosses_trust_boundary: false,
  source_type: 'process',
  target_type: 'process',
  source_name: 'Source',
  target_name: 'Target',
  ...over,
});

// A rule's example as the element the library is asked about.
function inputOf(rule: Rule, example: Rule['examples']['applies'][number]): ElementInput {
  const flags: Record<string, boolean> = {};
  for (const [flag, state] of Object.entries(example.flags)) if (state !== 'not_assessed') flags[flag] = state === 'yes';
  return {
    type: rule.element_type,
    name: 'Example',
    properties: { flags },
    ...(example.flow
      ? { flow: flowOf({ crosses_trust_boundary: example.flow.crosses_trust_boundary === 'yes', source_type: example.flow.source_type, target_type: example.flow.target_type }) }
      : {}),
  };
}

describe('unmetConditions: the declared examples of every shipped rule', () => {
  it('has no unmet condition for an "applies" example, and at least one for a "does not apply" example', () => {
    let checked = 0;
    for (const rule of library.rules) {
      for (const example of rule.examples.applies) {
        expect(library.unmetConditions(inputOf(rule, example), rule.id), `${rule.id} applies`).toEqual([]);
        checked += 1;
      }
      for (const example of rule.examples.does_not_apply) {
        expect(library.unmetConditions(inputOf(rule, example), rule.id).length, `${rule.id} does not apply`).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(library.rules.length);
  });
});

describe('unmetConditions: each kind of fact', () => {
  // One rule per kind, so each test names exactly the conditions it expects.
  const set: Library = parseLibrary(
    files(
      ruleFile('process', {
        id: 'p-order',
        category: 'Tampering',
        title: 'Order of {{element}}',
        when: { flags: { runs_privileged: 'yes', internet_facing: 'no', authenticated: undefined } },
        examples: { applies: [{ flags: { runs_privileged: 'yes', internet_facing: 'no' } }], does_not_apply: [{ flags: {} }] },
      }),
      ruleFile('data_flow'),
      ...coverageRuleFiles().filter((file) => !file.path.startsWith('data_flow/df-disclosure-test') && !file.path.startsWith('process/p-order')),
    ),
  );

  it('reports a flag the element has the wrong way round, with what the rule requires and what it has', () => {
    const at = (flags: Record<string, boolean>) => set.unmetConditions({ type: 'process', name: 'P', properties: { flags } }, 'p-order');
    expect(at({ runs_privileged: true, internet_facing: true })).toEqual([{ fact: 'flag', flag: 'internet_facing', required: 'no', actual: 'yes' }]);
    expect(at({ runs_privileged: false })).toEqual([{ fact: 'flag', flag: 'runs_privileged', required: 'yes', actual: 'no' }]);
  });

  it('reports a flag that is not assessed as such, and treats it as no', () => {
    const unmet = set.unmetConditions({ type: 'process', name: 'P', properties: { flags: { internet_facing: false } } }, 'p-order');
    expect(unmet).toEqual([{ fact: 'flag', flag: 'runs_privileged', required: 'yes', actual: 'not_assessed' }]);
    // "no" required and not assessed: the condition holds, so it is not reported.
    expect(set.unmetConditions({ type: 'process', name: 'P', properties: { flags: { runs_privileged: true } } }, 'p-order')).toEqual([]);
  });

  it('lists several unmet flags in the order the rule lists them', () => {
    const unmet = set.unmetConditions({ type: 'process', name: 'P', properties: { flags: { internet_facing: true } } }, 'p-order');
    expect(unmet.map((u) => (u.fact === 'flag' ? u.flag : u.fact))).toEqual(['runs_privileged', 'internet_facing']);
  });

  it('reports the flow facts after the flags: crossing, then source, then target', () => {
    const rules = parseLibrary(
      files(
        ruleFile('data_flow', {
          id: 'df-all',
          title: 'All of {{element}}',
          when: { flags: { encrypted_in_transit: 'no' }, flow: { crosses_trust_boundary: 'yes', source_type: 'external_entity', target_type: 'data_store' } },
          examples: {
            applies: [{ flags: {}, flow: { crosses_trust_boundary: 'yes', source_type: 'external_entity', target_type: 'data_store' } }],
            does_not_apply: [{ flags: { encrypted_in_transit: 'yes' }, flow: { crosses_trust_boundary: 'yes', source_type: 'external_entity', target_type: 'data_store' } }],
          },
        }),
      ),
    );
    const unmet = rules.unmetConditions(
      { type: 'data_flow', name: 'F', properties: { flags: { encrypted_in_transit: true } }, flow: flowOf({ crosses_trust_boundary: false, source_type: 'process', target_type: 'process' }) },
      'df-all',
    );
    expect(unmet).toEqual([
      { fact: 'flag', flag: 'encrypted_in_transit', required: 'no', actual: 'yes' },
      { fact: 'crosses_trust_boundary', required: 'yes', actual: 'no' },
      { fact: 'source_type', required: 'external_entity', actual: 'process' },
      { fact: 'target_type', required: 'data_store', actual: 'process' },
    ]);
  });

  it('reports only the element type when the element is not of the rule’s type, without comparing flags', () => {
    expect(set.unmetConditions({ type: 'data_store', name: 'D', properties: { flags: { encrypted_at_rest: true } } }, 'p-order')).toEqual([
      { fact: 'element_type', required: 'process', actual: 'data_store' },
    ]);
  });
});

describe('unmetConditions: errors', () => {
  const element: ElementInput = { type: 'process', name: 'P', properties: {} };

  it('refuses an id that is not an active rule, retired or unknown', () => {
    expect(() => library.unmetConditions(element, 'no-such-rule')).toThrow(LibraryInputError);
    const withRetired = parseLibrary(
      files(
        ...coverageRuleFiles(),
        { path: 'retired.yaml', text: JSON.stringify({ retired: [{ id: 'p-old', retired_on: '2026-10-01', reason: 'Replaced.', replaced_by: [] }] }) },
      ),
    );
    expect(() => withRetired.unmetConditions(element, 'p-old')).toThrow(LibraryInputError);
  });

  it('refuses properties outside the vocabulary, as candidatesFor does, without echoing them', () => {
    const rule = library.rules.find((r) => r.element_type === 'process');
    if (!rule) throw new Error('no process rule');
    const bad: ElementInput = { type: 'process', name: 'P', properties: { flags: { secret_flag_name: true } } };
    expect(() => library.unmetConditions(bad, rule.id)).toThrow(LibraryInputError);
    expect(() => library.unmetConditions(bad, rule.id)).toThrow(/^(?!.*secret_flag_name)/);
  });
});

describe('unmetConditions agrees with candidatesFor', () => {
  // Every combination of an element type's flags, and for flows every context: the rule is returned as a
  // candidate exactly when nothing is unmet.
  const combinations = <T,>(keys: readonly T[]): T[][] => keys.reduce<T[][]>((all, key) => all.flatMap((chosen) => [chosen, [...chosen, key]]), [[]]);

  it.each(RULE_ELEMENT_TYPES)('for every flag combination of a %s', (type) => {
    const flags = ELEMENT_FLAGS[type];
    const contexts: (FlowContext | undefined)[] =
      type === 'data_flow'
        ? [true, false].flatMap((crosses) => NODE_TYPES.flatMap((source) => NODE_TYPES.map((target) => flowOf({ crosses_trust_boundary: crosses, source_type: source, target_type: target }))))
        : [undefined];
    for (const subset of combinations(flags)) {
      // Three states per flag would be exhaustive; yes/absent covers "not assessed counts as no" and the rest follows from it.
      const properties = { flags: Object.fromEntries(subset.map((flag) => [flag, true])) };
      for (const flow of contexts) {
        const element: ElementInput = { type, name: 'E', properties, ...(flow ? { flow } : {}) };
        const candidates = new Set(library.candidatesFor(element).map((c) => c.rule_id));
        for (const rule of library.rules.filter((r) => r.element_type === type)) {
          expect(library.unmetConditions(element, rule.id).length === 0, rule.id).toBe(candidates.has(rule.id));
        }
      }
    }
  });
});

describe('the library and core agree on the type sets a rule can name', () => {
  it('has the same rule element types and node types as core, which cannot import the library', () => {
    expect([...RULE_ELEMENT_TYPES]).toEqual([...CORE_RULE_ELEMENT_TYPES]);
    expect([...NODE_TYPES]).toEqual([...CORE_NODE_TYPES]);
  });
});
