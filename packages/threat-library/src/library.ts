import type { UnmetCondition } from '@scrylux/core';
import { checkInput, matches, toCandidate, unmet, type Candidate, type ElementInput } from './evaluate.js';
import { LibraryInputError } from './errors.js';
import type { RetirementRecord, Rule } from './rule-schema.js';
import { STRIDE_PER_ELEMENT, RULE_ELEMENT_TYPES, type RuleElementType } from './stride.js';

export type { RetirementRecord, Rule } from './rule-schema.js';

// Everything the library returns is frozen: a caller cannot change a rule other callers will see.
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// How many active rules cover one cell of STRIDE-per-element (spec FR-017).
export interface CoverageRow {
  readonly element_type: RuleElementType;
  readonly category: Rule['category'];
  readonly active_rules: number;
}

// The 15 cells, in STRIDE-per-element order.
export function coverageOf(rules: readonly Rule[]): CoverageRow[] {
  return RULE_ELEMENT_TYPES.flatMap((element_type) =>
    STRIDE_PER_ELEMENT[element_type].map((category) => ({
      element_type,
      category,
      active_rules: rules.filter(
        (rule) => rule.element_type === element_type && rule.category === category,
      ).length,
    })),
  );
}

export type LookupResult =
  | { readonly status: 'active'; readonly rule: Rule }
  | {
      readonly status: 'retired';
      readonly retired_on: string;
      readonly reason: string;
      readonly replaced_by: readonly string[];
    }
  | { readonly status: 'unknown' };

export interface Library {
  readonly rules: readonly Rule[]; // active rules, sorted by id
  readonly retired: readonly RetirementRecord[]; // sorted by id
  // The candidate threats for one element: every active rule that applies, ordered by rule id. Pure:
  // it reads and writes nothing, so the same element always gives the same answer (FR-015).
  candidatesFor(element: ElementInput): readonly Candidate[];
  // Which conditions of an active rule an element does not meet (empty when the rule applies), with what
  // the rule requires and what the element has. Agrees with candidatesFor by construction: both use the
  // same comparisons. Throws LibraryInputError for an id that is not an active rule, or invalid input.
  unmetConditions(element: ElementInput, ruleId: string): readonly UnmetCondition[];
  // Whether a library reference is an active rule, a retired one (with what was kept of it), or
  // unknown. Any string is accepted (FR-020).
  lookup(reference: string): LookupResult;
  // The number of active rules for each element type and STRIDE category pair (FR-017).
  coverage(): readonly CoverageRow[];
}

// Plain code-unit comparison, never localeCompare: the result must not depend on the locale (FR-015).
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function createLibrary(
  rules: readonly Rule[],
  retired: readonly RetirementRecord[],
): Library {
  const sorted = [...rules].sort(byId);
  const byType = new Map<string, Rule[]>();
  for (const rule of sorted)
    byType.set(rule.element_type, [...(byType.get(rule.element_type) ?? []), rule]);

  // Results are built once and frozen, so a caller cannot change what other callers are given. Maps,
  // not objects: a reference such as '__proto__' or 'constructor' is just an unknown id.
  const results = new Map<string, LookupResult>();
  for (const record of retired) {
    const { retired_on, reason, replaced_by } = record;
    results.set(record.id, deepFreeze({ status: 'retired', retired_on, reason, replaced_by }));
  }
  for (const rule of sorted) results.set(rule.id, deepFreeze({ status: 'active', rule }));
  const unknown: LookupResult = deepFreeze({ status: 'unknown' });
  const coverage = deepFreeze(coverageOf(sorted));

  return deepFreeze({
    rules: sorted,
    retired: [...retired].sort(byId),
    candidatesFor(element: ElementInput): readonly Candidate[] {
      const facts = checkInput(element);
      const candidates = (byType.get(element.type as RuleElementType) ?? [])
        .filter((rule) => matches(rule, facts))
        .map((rule) => toCandidate(rule, facts.names));
      return Object.freeze(candidates);
    },
    unmetConditions(element: ElementInput, ruleId: string): readonly UnmetCondition[] {
      const found = results.get(ruleId);
      if (found?.status !== 'active') throw new LibraryInputError('the id is not an active rule');
      return deepFreeze(unmet(found.rule, checkInput(element), element.type));
    },
    lookup(reference: string): LookupResult {
      return results.get(reference) ?? unknown;
    },
    coverage(): readonly CoverageRow[] {
      return coverage;
    },
  });
}
