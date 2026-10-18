import { randomUUID } from 'node:crypto';
import { parseLibrary, type Library, type RuleSourceFile } from '@scrylux/threat-library';
import type { ElementRow } from '../../src/rule-engine/flow-context.js';

// Small in-memory rule sets for the planner's tests. YAML 1.2 is a superset of JSON, so the rule
// files are written with JSON.stringify and the API needs no YAML dependency of its own.

type RuleType = 'external_entity' | 'process' | 'data_store' | 'data_flow';

interface RuleSpec {
  id: string;
  type: RuleType;
  category: string;
  flags?: Record<string, 'yes' | 'no'>;
  flow?: Record<string, string>;
  variant_group?: string;
  // One example that applies and one that does not, as the checks require.
  applies: Record<string, unknown>;
  doesNotApply?: Record<string, unknown>;
}

export function rule(spec: RuleSpec): RuleSourceFile {
  const when: Record<string, unknown> = {};
  if (spec.flags) when['flags'] = spec.flags;
  if (spec.flow) when['flow'] = spec.flow;
  const body = {
    id: spec.id,
    element_type: spec.type,
    category: spec.category,
    title: `Title of ${spec.id} on {{element}}`,
    description: `Description of ${spec.id} for {{element}}.`,
    likelihood: 'Medium',
    impact: 'High',
    ...(Object.keys(when).length > 0 ? { when } : {}),
    ...(spec.variant_group ? { variant_group: spec.variant_group } : {}),
    mitigations: [`First mitigation of ${spec.id}.`, `Second mitigation of ${spec.id}.`],
    examples: {
      applies: [spec.applies],
      ...(spec.doesNotApply ? { does_not_apply: [spec.doesNotApply] } : {}),
    },
  };
  return { path: `${spec.type}/${spec.id}.yaml`, text: JSON.stringify(body) };
}

// A library of the given rules, with a consistent registry and no retirements unless given.
export function libraryOf(
  rules: RuleSourceFile[],
  retired: { id: string; retired_on: string; reason: string; replaced_by?: string[] }[] = [],
): Library {
  const ids = [...rules.map((file) => /([^/]+)\.yaml$/.exec(file.path)?.[1] ?? ''), ...retired.map((r) => r.id)].sort();
  return parseLibrary([
    ...rules,
    { path: 'ids.yaml', text: JSON.stringify({ ids }) },
    { path: 'retired.yaml', text: JSON.stringify({ retired }) },
  ]);
}

export function element(overrides: Partial<ElementRow> & Pick<ElementRow, 'type'>): ElementRow {
  return {
    id: randomUUID(),
    name: `${overrides.type}-${randomUUID().slice(0, 4)}`,
    properties: {},
    source_element_id: null,
    target_element_id: null,
    parent_boundary_id: null,
    ...overrides,
  };
}

export function flow(source: ElementRow, target: ElementRow, overrides: Partial<ElementRow> = {}): ElementRow {
  return element({ type: 'data_flow', source_element_id: source.id, target_element_id: target.id, ...overrides });
}

// A counter-based id source, so a test can name the ids a plan assigns.
export function counterIds(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}
