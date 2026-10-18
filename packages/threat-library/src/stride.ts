import { STRIDE_CATEGORIES, type ElementType, type StrideCategory } from '@scrylux/core';

// The element types a rule can be written for. Trust boundaries carry no flags and STRIDE-per-element
// gives them no threats of their own (spec FR-002).
export const RULE_ELEMENT_TYPES = [
  'external_entity',
  'process',
  'data_store',
  'data_flow',
] as const satisfies readonly ElementType[];
export type RuleElementType = (typeof RULE_ELEMENT_TYPES)[number];

// The types a data flow can start or end at (spec FR-010a).
export const NODE_TYPES = [
  'external_entity',
  'process',
  'data_store',
] as const satisfies readonly ElementType[];
export type NodeType = (typeof NODE_TYPES)[number];

const [SPOOFING, TAMPERING, REPUDIATION, DISCLOSURE, DENIAL, ELEVATION] = STRIDE_CATEGORIES;

// STRIDE-per-element (spec FR-003). The 15 pairs here are also the coverage cells (FR-017).
export const STRIDE_PER_ELEMENT: Readonly<Record<RuleElementType, readonly StrideCategory[]>> =
  Object.freeze({
    external_entity: Object.freeze([SPOOFING, REPUDIATION]),
    process: Object.freeze([SPOOFING, TAMPERING, REPUDIATION, DISCLOSURE, DENIAL, ELEVATION]),
    data_store: Object.freeze([TAMPERING, REPUDIATION, DISCLOSURE, DENIAL]),
    data_flow: Object.freeze([TAMPERING, DISCLOSURE, DENIAL]),
  });
