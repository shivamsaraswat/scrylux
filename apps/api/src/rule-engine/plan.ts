import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  elementPropertiesSchema,
  type Impact,
  type Likelihood,
  type StaleReason,
  type StrideCategory,
  type ThreatGenerationResult,
} from '@scrylux/core';
import type { ElementInput, Library } from '@scrylux/threat-library';
import { computeFlowContexts, type ElementRow } from './flow-context.js';

// The pure half of the rule engine: from the diagram, the generated threats it already has and the
// library, decide what a run writes. No I/O; run.ts does the writing (research #1).

// A generated threat as stored, with the columns the plan needs.
export interface ExistingRuleThreat {
  id: string;
  element_id: string;
  library_ref: string;
  stale: StaleReason | null;
}

export interface PlannedMitigation {
  threat_id: string;
  description: string;
  status: 'proposed';
  external_ref: null;
}

export interface PlannedThreat {
  id: string;
  element_id: string;
  category: StrideCategory;
  title: string;
  description: string;
  likelihood: Likelihood;
  impact: Impact;
  status: 'open';
  origin: 'rule';
  library_ref: string;
  mitigations: PlannedMitigation[];
}

export interface StaleChange {
  id: string;
  stale: StaleReason | null;
}

export interface GenerationPlan {
  creates: PlannedThreat[];
  staleChanges: StaleChange[];
  counts: ThreatGenerationResult;
}

export interface PlanInput {
  elements: readonly ElementRow[];
  ruleThreats: readonly ExistingRuleThreat[];
  library: Library;
  // Where new threat ids come from; tests pass a counter.
  newId?: () => string;
}

// Why a generated threat that matches no candidate is stale (spec FR-011), from the library alone.
function reasonFor(library: Library, ref: string, input: ElementInput): StaleReason {
  const found = library.lookup(ref);
  if (found.status === 'unknown') return { reason: 'rule_unknown' };
  if (found.status === 'retired') {
    return { reason: 'rule_retired', retired_on: found.retired_on, retirement_reason: found.reason, replaced_by: [...found.replaced_by] };
  }
  const unmet = library.unmetConditions(input, ref);
  // The library names the same conditions its matcher uses, so an active rule that was not a candidate
  // always has one. Nothing unmet would be a bug, not a reason.
  if (unmet.length === 0) throw new Error('an active rule matched no candidate but has no unmet condition');
  return { reason: 'conditions_unmet', unmet: [...unmet] };
}

// A generated threat is identified by its element and its rule, nothing else (FR-006): the user may
// have edited every other field.
const keyOf = (elementId: string, rule: string): string => `${elementId}\0${rule}`;

export function planGeneration({ elements, ruleThreats, library, newId = randomUUID }: PlanInput): GenerationPlan {
  const flows = computeFlowContexts(elements);
  const stored = new Map(ruleThreats.map((threat) => [keyOf(threat.element_id, threat.library_ref), threat]));
  const creates: PlannedThreat[] = [];
  const skipped: string[] = [];
  // Every evaluated element as the library saw it, for explaining a stale threat afterwards.
  const inputs = new Map<string, ElementInput>();
  const matched = new Set<string>();
  const staleChanges: StaleChange[] = [];
  let existing = 0;
  let noLongerStale = 0;

  for (const element of elements) {
    // An element written before the property vocabulary existed may hold keys outside it. Milestone 1
    // keeps such rows readable, so one of them must not fail the whole run: it is skipped and
    // reported (FR-002a, research #15). The check uses the library's own schema, so any other input
    // error still fails loudly.
    if (!elementPropertiesSchema(element.type).safeParse(element.properties).success) {
      skipped.push(element.id);
      continue;
    }

    const flow = element.type === 'data_flow' ? flows.get(element.id) : undefined;
    const input: ElementInput = { type: element.type, name: element.name, properties: element.properties, ...(flow ? { flow } : {}) };
    inputs.set(element.id, input);
    // A trust boundary is evaluated by no rule (STRIDE-per-element gives it no threats of its own).
    if (element.type === 'trust_boundary') continue;

    for (const candidate of library.candidatesFor(input)) {
      // Already generated: left exactly as the user has it, whatever they changed (FR-007). Only a stale
      // marker that no longer holds is cleared (FR-012).
      const have = stored.get(keyOf(element.id, candidate.rule_id));
      if (have) {
        existing += 1;
        matched.add(have.id);
        if (have.stale !== null) {
          staleChanges.push({ id: have.id, stale: null });
          noLongerStale += 1;
        }
        continue;
      }
      const id = newId();
      creates.push({
        id,
        element_id: element.id,
        category: candidate.category,
        title: candidate.title,
        description: candidate.description,
        likelihood: candidate.likelihood,
        impact: candidate.impact,
        status: 'open',
        origin: 'rule',
        library_ref: candidate.rule_id,
        mitigations: candidate.mitigations.map((description) => ({ threat_id: id, description, status: 'proposed', external_ref: null })),
      });
    }
  }

  // A generated threat with no candidate any more: its rule no longer applies, was retired, or is gone.
  // One on a skipped element is left alone: nothing about that element was evaluated this time.
  const skippedIds = new Set(skipped);
  let newlyStale = 0;
  for (const threat of ruleThreats) {
    if (matched.has(threat.id) || skippedIds.has(threat.element_id)) continue;
    const input = inputs.get(threat.element_id);
    // The database keeps a threat's element in its own model, so a missing one means inconsistent input.
    if (!input) throw new Error('a generated threat refers to an element that is not in the diagram');
    const reason = reasonFor(library, threat.library_ref, input);
    if (threat.stale === null) newlyStale += 1;
    // An unchanged reason is no write (FR-008); a changed one replaces the old, without being counted.
    else if (isDeepStrictEqual(threat.stale, reason)) continue;
    staleChanges.push({ id: threat.id, stale: reason });
  }

  return {
    creates,
    staleChanges,
    counts: { created: creates.length, existing, newly_stale: newlyStale, no_longer_stale: noLongerStale, skipped_elements: skipped.sort() },
  };
}
