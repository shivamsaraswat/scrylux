import { MitigationCreateInput, ThreatCreateInput } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { shippedLibrary, type ElementInput, type Rule } from '../src/index.js';

// What Milestone 3 will do with a candidate: create a threat (origin 'rule', the rule id as library
// reference) and a mitigation for each suggestion. This proves directly that any candidate fits, with
// the longest names an element can have, instead of trusting two copies of the limits to agree.

const library = shippedLibrary();
const THREAT_MODEL = '11111111-1111-4111-8111-111111111111';
const ELEMENT = '22222222-2222-4222-8222-222222222222';
const THREAT = '33333333-3333-4333-8333-333333333333';

// The first element the rule applies to, named with the longest name an element can have.
function elementFor(rule: Rule, name: string): ElementInput {
  const [example] = rule.examples.applies;
  if (!example) throw new Error(`${rule.id} has no applies example`);
  const flags = Object.fromEntries(
    Object.entries(example.flags)
      .filter(([, state]) => state !== 'not_assessed')
      .map(([flag, state]) => [flag, state === 'yes']),
  );
  const input: ElementInput = { type: rule.element_type, name, properties: { flags } };
  if (example.flow) {
    input.flow = {
      crosses_trust_boundary: example.flow.crosses_trust_boundary === 'yes',
      source_type: example.flow.source_type,
      target_type: example.flow.target_type,
      source_name: name,
      target_name: name,
    };
  }
  return input;
}

describe.each([
  ['plain 200-character names', 'n'.repeat(200)],
  ['200-character names of surrogate pairs', '😀'.repeat(200)],
])('every shipped rule produces a candidate a threat can hold: %s', (_label, name) => {
  it.each(library.rules.map((rule) => [rule.id, rule] as const))('%s', (id, rule) => {
    const candidate = library.candidatesFor(elementFor(rule, name)).find((c) => c.rule_id === id);
    expect(candidate, `${id} applies to its own first example`).toBeDefined();
    if (!candidate) return;

    const threat = ThreatCreateInput.parse({
      threat_model_id: THREAT_MODEL,
      element_id: ELEMENT,
      category: candidate.category,
      title: candidate.title,
      description: candidate.description,
      likelihood: candidate.likelihood,
      impact: candidate.impact,
      origin: 'rule',
      library_ref: candidate.rule_id,
    });
    // Parsing trims, so a candidate must already be in the form a threat would store.
    expect(threat.title).toBe(candidate.title);
    expect(threat.description).toBe(candidate.description);

    expect(candidate.mitigations.length).toBeGreaterThanOrEqual(1);
    for (const description of candidate.mitigations) {
      expect(MitigationCreateInput.parse({ threat_id: THREAT, description }).description).toBe(
        description,
      );
    }
  });
});
