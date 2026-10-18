import {
  ELEMENT_TYPES,
  NAME_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  elementPropertiesSchema,
  type ElementType,
  type Impact,
  type Likelihood,
  type StrideCategory,
  type UnmetCondition,
} from '@scrylux/core';
import { LibraryInputError } from './errors.js';
import type { Rule } from './rule-schema.js';
import { NODE_TYPES, type NodeType } from './stride.js';

// What the library is told about a data flow beyond its own properties (spec FR-010a). The caller
// works these out from the diagram; FR-010b says when a flow crosses a trust boundary.
export interface FlowContext {
  crosses_trust_boundary: boolean;
  source_type: NodeType;
  target_type: NodeType;
  source_name: string;
  target_name: string;
}

// An element as stored. `properties` is checked here against the vocabulary, so a caller can pass a
// row straight through (research #4).
export interface ElementInput {
  type: ElementType;
  name: string;
  properties: unknown;
  flow?: FlowContext;
}

export interface Candidate {
  readonly rule_id: string;
  readonly category: StrideCategory;
  readonly title: string;
  readonly description: string;
  readonly likelihood: Likelihood;
  readonly impact: Impact;
  readonly mitigations: readonly string[];
  readonly references: readonly string[];
  readonly variant_group: string | null;
}

// The facts a rule's conditions are tested against. A flag that is absent is not assessed, which
// counts as no (FR-009).
export interface Facts {
  flags: Readonly<Record<string, boolean>>;
  flow?: { crosses_trust_boundary: boolean; source_type: NodeType; target_type: NodeType };
}

// The conditions of `rule` that an element of type `elementType` with these facts does not meet, in a
// fixed order: the element type; then the flags, in the order the rule lists them; then the flow
// facts: crossing, source type, target type. Empty means the rule applies. This is the one place the
// conditions are compared, so `matches` and the reasons the rule engine gives for a stale threat
// cannot disagree (Phase 2 / Milestone 3, research #4).
export function unmet(rule: Rule, facts: Facts, elementType: ElementType): UnmetCondition[] {
  // A rule for another type says nothing about this element's flags, which may not even exist there.
  if (elementType !== rule.element_type) {
    return [{ fact: 'element_type', required: rule.element_type, actual: elementType }];
  }
  const result: UnmetCondition[] = [];
  for (const [flag, wanted] of Object.entries(rule.when.flags)) {
    const have = facts.flags[flag];
    if ((have === true) !== (wanted === 'yes')) {
      result.push({ fact: 'flag', flag, required: wanted, actual: have === undefined ? 'not_assessed' : have ? 'yes' : 'no' });
    }
  }
  const { crosses_trust_boundary, source_type, target_type } = rule.when.flow;
  const flow = facts.flow;
  if (crosses_trust_boundary !== undefined && flow?.crosses_trust_boundary !== (crosses_trust_boundary === 'yes')) {
    result.push({ fact: 'crosses_trust_boundary', required: crosses_trust_boundary, actual: flow?.crosses_trust_boundary ? 'yes' : 'no' });
  }
  if (source_type !== undefined && flow?.source_type !== source_type) {
    result.push({ fact: 'source_type', required: source_type, actual: flow?.source_type ?? source_type });
  }
  if (target_type !== undefined && flow?.target_type !== target_type) {
    result.push({ fact: 'target_type', required: target_type, actual: flow?.target_type ?? target_type });
  }
  return result;
}

export function matches(rule: Rule, facts: Facts): boolean {
  return unmet(rule, facts, rule.element_type).length === 0;
}

const PLACEHOLDER = /\{\{(element|source|target)\}\}/g;

// Names go in as plain text in a single pass, so a name that looks like a placeholder is not expanded
// again; a replacer function keeps `$&` and friends in a name literal (FR-004a).
function fill(text: string, names: Readonly<Record<string, string | undefined>>): string {
  return text.replace(PLACEHOLDER, (placeholder, name: string) => names[name] ?? placeholder);
}

// Cut to the limit in code points (as @scrylux/core counts them), ending in an ellipsis (FR-004b).
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const characters = [...text];
  if (characters.length <= max) return text;
  return `${characters
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

export function toCandidate(
  rule: Rule,
  names: { element: string; source?: string; target?: string },
): Candidate {
  return Object.freeze({
    rule_id: rule.id,
    category: rule.category,
    title: shorten(fill(rule.title, names), NAME_MAX_LENGTH),
    description: shorten(fill(rule.description, names), DESCRIPTION_MAX_LENGTH),
    likelihood: rule.likelihood,
    impact: rule.impact,
    mitigations: rule.mitigations,
    references: rule.references,
    variant_group: rule.variant_group,
  });
}

const isNodeType = (value: unknown): value is NodeType =>
  (NODE_TYPES as readonly unknown[]).includes(value);

// Throws LibraryInputError for anything the library cannot answer for (FR-016). A message names the
// problem and never the rejected value.
export function checkInput(
  input: ElementInput,
): Facts & { names: { element: string; source?: string; target?: string } } {
  if (!(ELEMENT_TYPES as readonly unknown[]).includes(input.type))
    throw new LibraryInputError('unknown element type');
  if (typeof input.name !== 'string')
    throw new LibraryInputError('the element name must be a string');
  const properties = elementPropertiesSchema(input.type).safeParse(input.properties);
  if (!properties.success) {
    throw new LibraryInputError(
      `the properties are not valid for a ${input.type}: check them against the property vocabulary`,
    );
  }
  const flags = properties.data.flags ?? {};

  if (input.type !== 'data_flow') {
    if (input.flow !== undefined)
      throw new LibraryInputError('only a data flow has a flow context');
    return { flags, names: { element: input.name } };
  }
  const flow: unknown = input.flow;
  if (typeof flow !== 'object' || flow === null)
    throw new LibraryInputError('a data flow needs its flow context');
  const { crosses_trust_boundary, source_type, target_type, source_name, target_name } =
    flow as Record<string, unknown>;
  if (typeof crosses_trust_boundary !== 'boolean')
    throw new LibraryInputError('crosses_trust_boundary must be true or false');
  if (!isNodeType(source_type) || !isNodeType(target_type)) {
    throw new LibraryInputError(
      `the source and target types must each be one of ${NODE_TYPES.join(', ')}`,
    );
  }
  if (typeof source_name !== 'string' || typeof target_name !== 'string') {
    throw new LibraryInputError('the source and target names must be strings');
  }
  return {
    flags,
    flow: { crosses_trust_boundary, source_type, target_type },
    names: { element: input.name, source: source_name, target: target_name },
  };
}
