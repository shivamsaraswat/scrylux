import { ELEMENT_FLAGS, ELEMENT_TYPES, type ElementType } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import {
  STRIDE_PER_ELEMENT,
  shippedLibrary,
  type ElementInput,
  type NodeType,
} from '../src/index.js';

// The real rules/ directory, loaded the way the rule engine will load it. A broken shipped rule fails
// here, and nowhere else would notice (research #9).

const library = shippedLibrary();

// A small seeded generator, so the 1,000-element diagram is the same on every run.
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NODES: readonly NodeType[] = ['external_entity', 'process', 'data_store'];

function diagram(size: number): ElementInput[] {
  const random = generator(2026);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  return Array.from({ length: size }, (_, index): ElementInput => {
    const type: ElementType = pick(ELEMENT_TYPES);
    const flags: Record<string, boolean> = {};
    for (const flag of ELEMENT_FLAGS[type]) {
      const roll = random();
      if (roll < 0.35) flags[flag] = true;
      else if (roll < 0.7) flags[flag] = false;
    }
    const element: ElementInput = { type, name: `Element ${index}`, properties: { flags } };
    if (type === 'data_flow') {
      element.flow = {
        crosses_trust_boundary: random() < 0.5,
        source_type: pick(NODES),
        target_type: pick(NODES),
        source_name: `Source ${index}`,
        target_name: `Target ${index}`,
      };
    }
    return element;
  });
}

describe('the shipped library', () => {
  it('loads with no problem', () => {
    expect(() => shippedLibrary()).not.toThrow();
    expect(shippedLibrary()).toBe(library);
  });

  it('has between 40 and 60 active rules (SC-001)', () => {
    expect(library.rules.length).toBeGreaterThanOrEqual(40);
    expect(library.rules.length).toBeLessThanOrEqual(60);
  });

  it('covers every element type and category pair STRIDE-per-element allows (SC-002)', () => {
    const rows = library.coverage();
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      expect(row.active_rules, `${row.element_type} / ${row.category}`).toBeGreaterThanOrEqual(1);
    }
    expect(rows.map((row) => `${row.element_type}/${row.category}`)).toEqual(
      Object.entries(STRIDE_PER_ELEMENT).flatMap(([type, categories]) =>
        categories.map((category) => `${type}/${category}`),
      ),
    );
  });

  it('names every rule after its element type', () => {
    const prefix = {
      external_entity: 'ee-',
      process: 'p-',
      data_store: 'ds-',
      data_flow: 'df-',
    } as const;
    for (const rule of library.rules)
      expect(rule.id.startsWith(prefix[rule.element_type]), rule.id).toBe(true);
  });

  it('gives every rule an example that applies and, when it has conditions, one that does not (SC-003)', () => {
    for (const rule of library.rules) {
      expect(rule.examples.applies.length, rule.id).toBeGreaterThanOrEqual(1);
      const conditional =
        Object.keys(rule.when.flags).length + Object.keys(rule.when.flow).length > 0;
      if (conditional)
        expect(rule.examples.does_not_apply.length, rule.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives a freshly drawn element of every type except a trust boundary at least one candidate (SC-005)', () => {
    for (const type of ['external_entity', 'process', 'data_store'] as const) {
      expect(
        library.candidatesFor({ type, name: 'New', properties: {} }).length,
        type,
      ).toBeGreaterThanOrEqual(1);
    }
    for (const crosses of [true, false]) {
      const candidates = library.candidatesFor({
        type: 'data_flow',
        name: 'New flow',
        properties: {},
        flow: {
          crosses_trust_boundary: crosses,
          source_type: 'process',
          target_type: 'process',
          source_name: 'A',
          target_name: 'B',
        },
      });
      expect(candidates.length, `data_flow crossing=${crosses}`).toBeGreaterThanOrEqual(1);
    }
    expect(library.candidatesFor({ type: 'trust_boundary', name: 'DMZ', properties: {} })).toEqual(
      [],
    );
  });

  it('covers the themes of FR-018', () => {
    const ids = new Set(library.rules.map((rule) => rule.id));
    const themes = [
      'ee-spoofing-unauthenticated-internet', // spoofing of unauthenticated external entities
      'p-spoofing-anonymous-callers-internet', // missing authentication on processes
      'df-tampering-forged-messages-crossing', // missing authentication on data flows
      'df-disclosure-plaintext-crossing', // data sent unencrypted in transit
      'ds-disclosure-unencrypted-at-rest', // sensitive data stored unencrypted at rest
      'df-tampering-plaintext-crossing', // unencrypted flows that cross a trust boundary
      'p-tampering-untrusted-input-internet', // exposure of internet-facing processes
      'ds-disclosure-public-exposure', // exposure of internet-facing data stores
      'p-elevation-privileged-compromise', // processes running with elevated privileges
      'p-repudiation-no-audit-log', // missing audit trail for processes
      'ds-repudiation-no-change-history', // missing audit trail for data stores
      'df-tampering-plaintext-internal', // tampering with data in transit
      'ds-tampering-unauthorized-write-internal', // tampering with data at rest
      'p-dos-resource-exhaustion-internet', // denial of service against processes
      'ds-dos-storage-exhaustion', // denial of service against data stores
      'df-dos-flooding-crossing', // denial of service against flows
    ];
    for (const id of themes) expect(ids.has(id), id).toBe(true);
  });
});

describe('evaluating a large diagram', () => {
  const elements = diagram(1000);

  it('answers for all 1,000 elements in under a second (SC-006)', () => {
    const started = performance.now();
    for (const element of elements) library.candidatesFor(element);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('gives identical results when repeated (SC-007)', () => {
    const first = elements.map((element) => library.candidatesFor(element));
    const second = elements.map((element) => library.candidatesFor(element));
    expect(second).toEqual(first);
    expect(first.some((candidates) => candidates.length > 0)).toBe(true);
  });

  it('never returns two candidates of one variant group for an element', () => {
    for (const element of elements) {
      const groups = library
        .candidatesFor(element)
        .map((candidate) => candidate.variant_group)
        .filter((group): group is string => group !== null);
      expect(new Set(groups).size).toBe(groups.length);
    }
  });

  it('returns candidates in rule id order', () => {
    for (const element of elements.slice(0, 200)) {
      const ids = library.candidatesFor(element).map((candidate) => candidate.rule_id);
      expect(ids).toEqual([...ids].sort());
    }
  });
});
