import { absoluteRects, deriveRisk, describeStale, ELEMENT_FLAGS, FLAG_LABELS, lifecycleGap, resolveLayout, STRIDE_CATEGORIES, summarizeThreats, type ElementRecord } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { computeFlowContexts } from '../../src/rule-engine/flow-context.js';
import { buildReport, type BoundaryGroup, type Report } from '../../src/report/model.js';
import {
  duplicateNames,
  element,
  elementId,
  empty,
  EXPORTED_AT,
  HOSTILE,
  hostile,
  LONG_TOKEN,
  shuffled,
  threat,
  threatId,
  typical,
  unplaced,
} from './fixtures.js';

// data-model.md §2-§4: the report model both renderers draw from.

function groupsDepthFirst(report: Report): BoundaryGroup[] {
  const walk = (group: BoundaryGroup): BoundaryGroup[] => [group, ...group.children.flatMap(walk)];
  return [...report.groups.flatMap(walk), report.outside];
}

const allElements = (report: Report) => groupsDepthFirst(report).flatMap((group) => group.elements);
const allThreatLists = (report: Report) => [
  ...groupsDepthFirst(report).flatMap((group) => [group.ownThreats, ...group.elements.map((e) => e.threats)]),
  report.unlinked,
];
const allThreats = (report: Report) => allThreatLists(report).flat();
const allMitigations = (report: Report) => allThreats(report).flatMap((t) => t.mitigations);
const sectionRefs = (report: Report): string[] =>
  groupsDepthFirst(report).flatMap((group) => [...(group.boundary ? [group.boundary.ref] : []), ...group.elements.map((e) => e.ref)]);
const byName = (report: Report, name: string) => {
  const found = [...allElements(report), ...groupsDepthFirst(report).flatMap((g) => (g.boundary ? [g.boundary] : []))].find((e) => e.name === name);
  if (!found) throw new Error(`no element named ${name}`);
  return found;
};
const groupOf = (report: Report, name: string): BoundaryGroup => {
  const found = groupsDepthFirst(report).find((group) => group.elements.some((e) => e.name === name));
  if (!found) throw new Error(`${name} is in no group`);
  return found;
};

describe('buildReport', () => {
  describe('invariants (data-model.md §4)', () => {
    it('puts every threat in exactly one place, and every mitigation under its own threat', () => {
      const snap = typical();
      const report = buildReport(snap, EXPORTED_AT);
      const threatIds = allThreats(report).map((t) => t.id);
      expect([...threatIds].sort()).toEqual(snap.threats.map((t) => t.id).sort());
      expect(new Set(threatIds).size).toBe(threatIds.length);
      const mitigationIds = allMitigations(report).map((m) => m.id);
      expect([...mitigationIds].sort()).toEqual(snap.mitigations.map((m) => m.id).sort());
      expect(new Set(mitigationIds).size).toBe(mitigationIds.length);
      for (const t of allThreats(report)) {
        const stored = snap.mitigations.filter((m) => m.threat_id === t.id).map((m) => m.id);
        expect(t.mitigations.map((m) => m.id).sort()).toEqual(stored.sort());
      }
    });

    it('gives every element exactly one section, with a unique reference', () => {
      const snap = typical();
      const report = buildReport(snap, EXPORTED_AT);
      const refs = sectionRefs(report);
      expect(refs).toHaveLength(snap.elements.length);
      expect(new Set(refs).size).toBe(refs.length);
      const ids = [...allElements(report), ...groupsDepthFirst(report).flatMap((g) => (g.boundary ? [g.boundary] : []))].map((e) => e.id);
      expect([...ids].sort()).toEqual(snap.elements.map((e) => e.id).sort());
    });

    it('summarises the threats exactly as the threat list does (FR-004)', () => {
      const snap = typical();
      expect(buildReport(snap, EXPORTED_AT).summary).toEqual(summarizeThreats(snap.threats));
    });

    it.each([typical, unplaced, duplicateNames, hostile])('does not depend on the order of the records (FR-013): %o', (build) => {
      const snap = build();
      const expected = buildReport(snap, EXPORTED_AT);
      for (const seed of [1, 7, 42, 2026]) expect(buildReport(shuffled(snap, seed), EXPORTED_AT)).toEqual(expected);
    });

    it('does not transform any user text', () => {
      const snap = hostile();
      const report = buildReport(snap, EXPORTED_AT);
      expect(report.header.threatModelName).toBe(snap.model.name);
      expect(report.header.projectName).toBe(snap.project.name);
      for (const t of allThreats(report)) {
        const stored = snap.threats.find((s) => s.id === t.id);
        expect(t.title).toBe(stored?.title);
        expect(t.description).toBe(stored?.description);
        expect(t.statusReason).toBe(stored?.status_reason);
      }
      for (const m of allMitigations(report)) {
        const stored = snap.mitigations.find((s) => s.id === m.id);
        expect(m.description).toBe(stored?.description);
        expect(m.ticket?.text).toBe(stored?.external_ref);
      }
      const names = new Set(allElements(report).map((e) => e.name));
      for (const text of HOSTILE) expect(names.has(text)).toBe(true);
    });

    it('keeps a 300-character token whole', () => {
      const report = buildReport(typical(), EXPORTED_AT);
      expect(allThreats(report).find((t) => t.title === 'Long token')?.description).toBe(LONG_TOKEN);
    });

    it('holds no flowchart: the Markdown renderer draws it from the diagram', () => {
      expect('mermaid' in buildReport(typical(), EXPORTED_AT).diagram).toBe(false);
    });
  });

  describe('grouping by trust boundary (research #6)', () => {
    const report = buildReport(typical(), EXPORTED_AT);

    it('nests a boundary inside the one that holds it', () => {
      expect(report.groups.map((g) => g.boundary?.name)).toEqual(['Internal network']);
      const outer = report.groups[0] as BoundaryGroup;
      expect(outer.children.map((g) => g.boundary?.name)).toEqual(['DB zone']);
      expect(outer.children[0]?.path).toEqual(['Internal network', 'DB zone']);
      expect(outer.path).toEqual(['Internal network']);
    });

    it('puts each node in the group of its own boundary', () => {
      expect(groupOf(report, 'API').boundary?.name).toBe('Internal network');
      expect(groupOf(report, 'Orders DB').boundary?.name).toBe('DB zone');
      expect(groupOf(report, 'Browser')).toBe(report.outside);
    });

    it('puts a flow in the innermost boundary that holds both of its ends', () => {
      expect(groupOf(report, 'SQL').boundary?.name).toBe('Internal network');
      expect(groupOf(report, 'Jobs').boundary?.name).toBe('Internal network');
      expect(groupOf(report, 'HTTPS request')).toBe(report.outside);
    });

    it("keeps a boundary's own threats apart from its elements' threats (M4 FR-014)", () => {
      const outer = report.groups[0] as BoundaryGroup;
      expect(outer.ownThreats.map((t) => t.title)).toEqual(['Boundary privilege escalation']);
      expect(outer.elements.flatMap((e) => e.threats).map((t) => t.title)).not.toContain('Boundary privilege escalation');
      expect(report.groups[0]?.children[0]?.ownThreats).toEqual([]);
    });

    it('lists the model-level threats apart', () => {
      expect(report.unlinked.map((t) => t.title).sort()).toEqual(['Provider outage', 'Unattributed decisions']);
    });
  });

  describe('order (data-model.md §3)', () => {
    it('orders the elements of a group by type, then name', () => {
      const report = buildReport(typical(), EXPORTED_AT);
      const outer = report.groups[0] as BoundaryGroup;
      expect(outer.elements.map((e) => `${e.type}:${e.name}`)).toEqual([
        'process:API',
        'process:Worker',
        'data_flow:Jobs',
        'data_flow:SQL',
      ]);
    });

    it('orders the threats of an element by risk, then category, then title', () => {
      const report = buildReport(typical(), EXPORTED_AT);
      const api = byName(report, 'API');
      expect(api.threats.map((t) => t.title)).toEqual(['Request tampering', 'Session token replay', 'Stale rule threat']);
      expect(api.threats.map((t) => t.risk)).toEqual(['Critical', 'High', 'Medium']);

      const snap = {
        ...empty(),
        elements: [element(1)],
        threats: [
          threat(1, { element_id: elementId(1), title: 'b', category: 'Tampering' }),
          threat(2, { element_id: elementId(1), title: 'a', category: 'Tampering' }),
          threat(3, { element_id: elementId(1), title: 'z', category: 'Spoofing' }),
          threat(4, { element_id: elementId(1), title: 'a', category: 'Tampering' }),
        ],
      };
      const ordered = buildReport(snap, EXPORTED_AT).outside.elements[0]?.threats ?? [];
      expect(ordered.map((t) => `${t.category}/${t.title}`)).toEqual(['Spoofing/z', 'Tampering/a', 'Tampering/a', 'Tampering/b']);
      expect(STRIDE_CATEGORIES.indexOf('Spoofing')).toBeLessThan(STRIDE_CATEGORIES.indexOf('Tampering'));
      // Equal risk, category and title: the id decides.
      expect(ordered.slice(1, 3).map((t) => t.id)).toEqual([threatId(2), threatId(4)]);
    });

    it('compares names by code point, not by locale (FR-013)', () => {
      const snap = {
        ...empty(),
        elements: ['a', 'Z', 'é', 'f'].map((name, i) => element(i + 1, { name })),
      };
      const names = buildReport(snap, EXPORTED_AT).outside.elements.map((e) => e.name);
      expect(names).toEqual(['Z', 'a', 'f', 'é']);
      expect(['a', 'Z', 'é', 'f'].sort((a, b) => a.localeCompare(b))).not.toEqual(names);
    });

    it('puts a character outside the basic plane after one from U+E000 to U+FFFF, as code points do', () => {
      // UTF-16 order, which `<` on strings uses, would put the emoji first.
      const snap = { ...empty(), elements: ['😀', '\uFF21'].map((name, i) => element(i + 1, { name })) };
      expect(buildReport(snap, EXPORTED_AT).outside.elements.map((e) => e.name)).toEqual(['\uFF21', '😀']);
    });

    it('orders sibling boundaries by name', () => {
      const snap = {
        ...empty(),
        elements: [
          element(1, { type: 'trust_boundary', name: 'b', layout: { x: 0, y: 0, width: 100, height: 100 } }),
          element(2, { type: 'trust_boundary', name: 'a', layout: { x: 200, y: 0, width: 100, height: 100 } }),
        ],
      };
      expect(buildReport(snap, EXPORTED_AT).groups.map((g) => g.boundary?.name)).toEqual(['a', 'b']);
    });
  });

  describe('references and names (research #12)', () => {
    it('numbers the sections depth first, in the order they appear', () => {
      const report = buildReport(typical(), EXPORTED_AT);
      const order = [
        'Internal network',
        'API',
        'Worker',
        'Jobs',
        'SQL',
        'DB zone',
        'Orders DB',
        'Browser',
        'HTTPS request',
      ];
      expect(order.map((name) => byName(report, name).ref)).toEqual(order.map((_, i) => `E${i + 1}`));
    });

    it('tells apart two elements with the same name', () => {
      const report = buildReport(duplicateNames(), EXPORTED_AT);
      const workers = report.outside.elements.filter((e) => e.name === 'Worker');
      expect(workers).toHaveLength(2);
      expect(workers.map((e) => e.displayName)).toEqual(workers.map((e) => `Worker (${e.ref})`));
      expect(report.outside.elements.find((e) => e.name === 'Unique')?.displayName).toBe('Unique');
    });
  });

  describe('what a threat shows (FR-010)', () => {
    const report = buildReport(typical(), EXPORTED_AT);
    const threatNamed = (title: string) => {
      const found = allThreats(report).find((t) => t.title === title);
      if (!found) throw new Error(title);
      return found;
    };

    it('labels the status and the origin', () => {
      expect(threatNamed('Session token replay').statusLabel).toBe('Accepted');
      expect(threatNamed('Disk theft').statusLabel).toBe('Mitigated');
      expect(threatNamed('Eavesdropping').statusLabel).toBe('Not applicable');
      expect(threatNamed('Request tampering').statusLabel).toBe('Open');
      expect(threatNamed('Request tampering').originLabel).toBe('Manual');
      expect(threatNamed('Session token replay').originLabel).toBe('Rule-generated');
      expect(threatNamed('AI-found tampering').originLabel).toBe('AI-drafted');
    });

    it('keeps the risk and its inputs', () => {
      const t = threatNamed('Session token replay');
      expect([t.likelihood, t.impact, t.risk]).toEqual(['High', 'Medium', deriveRisk('High', 'Medium')]);
    });

    it('explains staleness in the threat list’s own words', () => {
      expect(threatNamed('Stale rule threat').stale).toBe(describeStale({ reason: 'rule_unknown' }));
      expect(threatNamed('Request tampering').stale).toBeNull();
    });

    it('reports what a status is missing, using the lifecycle rule', () => {
      expect(threatNamed('Unattributed decisions').gap).toBe('reason_missing');
      expect(threatNamed('Queue flooding').gap).toBe('no_implemented_mitigation');
      expect(threatNamed('Disk theft').gap).toBeNull();
      expect(threatNamed('Session token replay').gap).toBeNull();
      const snap = typical();
      const queue = snap.threats.find((t) => t.title === 'Queue flooding');
      expect(queue && lifecycleGap(queue, snap.mitigations.filter((m) => m.threat_id === queue.id))).toBe('no_implemented_mitigation');
    });

    it('links a ticket only when it is an http or https address (FR-015)', () => {
      const tickets = allMitigations(report).map((m) => [m.description, m.ticket]);
      expect(tickets).toContainEqual(['Encrypt the volume', { text: 'https://tracker.example/SEC-12', href: 'https://tracker.example/SEC-12' }]);
      expect(tickets).toContainEqual(['Rotate signing keys', { text: 'JIRA-7', href: null }]);
      expect(tickets).toContainEqual(['Add a queue limit', null]);
      const hostileHrefs = allMitigations(buildReport(hostile(), EXPORTED_AT)).flatMap((m) => (m.ticket?.href ? [m.ticket.href] : []));
      expect(hostileHrefs.every((href) => /^https?:\/\//.test(href))).toBe(true);
    });

    it('orders mitigations by description', () => {
      const t = threatNamed('Session token replay');
      expect(t.mitigations.map((m) => m.description)).toEqual(['Bind tokens to the session', 'Rotate signing keys']);
      expect(t.mitigations.map((m) => m.statusLabel)).toEqual(['Implemented', 'Proposed']);
    });
  });

  describe('header', () => {
    it('shows the instant in UTC to the minute, and the counts', () => {
      const snap = typical();
      const { header } = buildReport(snap, new Date('2026-10-10T23:59:30Z'));
      expect(header).toMatchObject({
        threatModelName: 'Payments API',
        projectName: 'Checkout',
        methodology: 'STRIDE',
        threatModelStatus: 'In review',
        exportedAt: '2026-10-10 23:59 UTC',
        counts: { elements: snap.elements.length, threats: snap.threats.length, mitigations: snap.mitigations.length },
      });
    });
  });

  describe('diagram model (research #11)', () => {
    const sortedById = (elements: readonly ElementRecord[]) =>
      [...elements].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    it('draws every element where the canvas does', () => {
      for (const build of [typical, unplaced]) {
        const snap = build();
        const sorted = sortedById(snap.elements);
        const rects = absoluteRects(sorted, resolveLayout(sorted));
        const report = buildReport(snap, EXPORTED_AT);
        const drawn = [...report.diagram.nodes, ...report.diagram.boundaries];
        expect(drawn).toHaveLength(rects.size);
        for (const node of drawn) expect({ x: node.x, y: node.y, width: node.width, height: node.height }).toEqual(rects.get(node.id));
      }
    });

    it('draws outer boundaries before inner ones', () => {
      const { boundaries } = buildReport(typical(), EXPORTED_AT).diagram;
      expect(boundaries.map((b) => [b.displayName, b.depth])).toEqual([
        ['Internal network', 0],
        ['DB zone', 1],
      ]);
    });

    it('fits the view box to every rectangle plus a 40-unit margin, negative coordinates included', () => {
      const { diagram } = buildReport(typical(), EXPORTED_AT);
      const rects = [...diagram.nodes, ...diagram.boundaries];
      const minX = Math.min(...rects.map((r) => r.x));
      const minY = Math.min(...rects.map((r) => r.y));
      const maxX = Math.max(...rects.map((r) => r.x + r.width));
      const maxY = Math.max(...rects.map((r) => r.y + r.height));
      expect(minX).toBeLessThan(0);
      expect(diagram.viewBox).toEqual({ x: minX - 40, y: minY - 40, width: maxX - minX + 80, height: maxY - minY + 80 });
    });

    it('offsets flows that join the same two nodes, in either direction', () => {
      const snap = {
        ...empty(),
        elements: [
          element(1, { layout: { x: 0, y: 0 } }),
          element(2, { layout: { x: 300, y: 0 } }),
          element(3, { type: 'data_flow', name: 'there', layout: null, source_element_id: elementId(1), target_element_id: elementId(2) }),
          element(4, { type: 'data_flow', name: 'back', layout: null, source_element_id: elementId(2), target_element_id: elementId(1) }),
          element(5, { type: 'data_flow', name: 'again', layout: null, source_element_id: elementId(1), target_element_id: elementId(2) }),
        ],
      };
      const offsets = buildReport(snap, EXPORTED_AT).diagram.flows.map((f) => f.offset);
      expect([...offsets].sort((a, b) => a - b)).toEqual([-12, 0, 12]);
      const single = buildReport(typical(), EXPORTED_AT).diagram.flows;
      expect(single.every((f) => f.offset === 0)).toBe(true);
    });

    it('keeps the lines of many flows between the same two shapes on those shapes', () => {
      const flows = Array.from({ length: 401 }, (_, i) =>
        element(i + 3, { type: 'data_flow', name: `Flow ${i}`, layout: null, source_element_id: elementId(1), target_element_id: elementId(2) }),
      );
      const snap = { ...empty(), elements: [element(1, { layout: { x: 0, y: 0 } }), element(2, { layout: { x: 300, y: 0 } }), ...flows] };
      const offsets = buildReport(snap, EXPORTED_AT).diagram.flows.map((f) => f.offset);
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(48);
      expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(24);
    });

    it('has no view box when there is nothing to draw', () => {
      expect(buildReport(empty(), EXPORTED_AT).diagram.viewBox).toBeNull();
    });
  });

  describe('what an element is (FR-005, spec US3)', () => {
    const report = buildReport(typical(), EXPORTED_AT);
    const flagsOf = (name: string) => byName(report, name).flags.map((flag) => `${flag.label}: ${flag.value}`);

    it('lists the technology tags in the order they were stored', () => {
      expect(byName(report, 'API').tags).toEqual(['Node.js', 'Express']);
      expect(byName(report, 'Orders DB').tags).toEqual(['PostgreSQL']);
      expect(byName(report, 'Browser').tags).toEqual([]);
    });

    it('lists each security flag of the element’s type, in the vocabulary’s order, as Yes, No or Not assessed', () => {
      expect(flagsOf('API')).toEqual([
        `${FLAG_LABELS.internet_facing}: Yes`,
        `${FLAG_LABELS.requires_authentication}: Yes`,
        `${FLAG_LABELS.handles_sensitive_data}: Not assessed`,
        `${FLAG_LABELS.runs_privileged}: No`,
      ]);
      expect(byName(report, 'API').flags.length).toBe(ELEMENT_FLAGS.process.length);
      expect(flagsOf('Orders DB')).toEqual([
        `${FLAG_LABELS.stores_sensitive_data}: Yes`,
        `${FLAG_LABELS.encrypted_at_rest}: Not assessed`,
        `${FLAG_LABELS.internet_facing}: Not assessed`,
      ]);
      expect(flagsOf('Browser')).toEqual([`${FLAG_LABELS.authenticated}: Not assessed`, `${FLAG_LABELS.internet_facing}: Not assessed`]);
      expect(flagsOf('HTTPS request')).toEqual([
        `${FLAG_LABELS.encrypted_in_transit}: Yes`,
        `${FLAG_LABELS.authenticated}: Not assessed`,
        `${FLAG_LABELS.carries_sensitive_data}: Not assessed`,
      ]);
      expect(flagsOf('Internal network')).toEqual([]);
    });

    it('reads what is stored leniently: a value that does not parse gives no tags and nothing assessed, and no error', () => {
      const stored: ElementRecord['properties'][] = [{ tags: 'not a list', flags: { internet_facing: 'yes' } }, { color: 'red' }, { flags: { not_a_flag: true } }, { tags: ['ok'], extra: 1 }];
      for (const properties of stored) {
        const snap = { ...empty(), elements: [element(1, { name: 'Odd', properties })] };
        const odd = byName(buildReport(snap, EXPORTED_AT), 'Odd');
        expect(odd.tags).toEqual([]);
        expect(odd.flags.map((flag) => flag.value)).toEqual(Array(ELEMENT_FLAGS.process.length).fill('Not assessed'));
      }
    });

    it('trims a stored tag as the API does', () => {
      const snap = { ...empty(), elements: [element(1, { name: 'Tagged', properties: { tags: ['  spaced  '] } })] };
      expect(byName(buildReport(snap, EXPORTED_AT), 'Tagged').tags).toEqual(['spaced']);
    });
  });

  describe('what a data flow joins (FR-005, spec US3)', () => {
    const report = buildReport(typical(), EXPORTED_AT);
    const flowOf = (name: string) => {
      const found = byName(report, name).flow;
      if (!found) throw new Error(`${name} has no flow`);
      return found;
    };

    it('names both ends, by reference and name, and the boundary each is in', () => {
      expect(flowOf('HTTPS request')).toEqual({
        source: { ref: 'E8', name: 'Browser', boundary: null },
        target: { ref: 'E2', name: 'API', boundary: 'Internal network' },
        crosses: true,
      });
      expect(flowOf('SQL')).toEqual({
        source: { ref: 'E2', name: 'API', boundary: 'Internal network' },
        target: { ref: 'E7', name: 'Orders DB', boundary: 'DB zone' },
        crosses: true,
      });
    });

    it('says a flow within one boundary does not cross one', () => {
      expect(flowOf('Jobs').crosses).toBe(false);
      expect(flowOf('Jobs').source.boundary).toBe('Internal network');
      expect(flowOf('Jobs').target.boundary).toBe('Internal network');
    });

    it('agrees with the rule engine about what crosses a trust boundary, for every flow', () => {
      const snap = typical();
      const contexts = computeFlowContexts(snap.elements);
      const flows = allElements(report).filter((e) => e.type === 'data_flow');
      expect(flows).toHaveLength(3);
      for (const flow of flows) expect(flow.flow?.crosses, flow.name).toBe(contexts.get(flow.id)?.crosses_trust_boundary);
    });

    it('is only on a data flow', () => {
      for (const e of allElements(report).filter((candidate) => candidate.type !== 'data_flow')) expect(e.flow, e.name).toBeNull();
    });

    it('does not tell two same-named ends apart by name alone', () => {
      const snap = {
        ...empty(),
        elements: [
          element(1, { name: 'Worker' }),
          element(2, { name: 'Worker', layout: { x: 300, y: 0 } }),
          element(3, { type: 'data_flow', name: 'Hands over', layout: null, source_element_id: elementId(1), target_element_id: elementId(2) }),
        ],
      };
      const flow = byName(buildReport(snap, EXPORTED_AT), 'Hands over').flow;
      expect([flow?.source.ref, flow?.target.ref]).toEqual(['E1', 'E2']);
    });
  });

  it('builds a report from an empty threat model', () => {
    const report = buildReport(empty(), EXPORTED_AT);
    expect(report.groups).toEqual([]);
    expect(report.outside.elements).toEqual([]);
    expect(report.outside.ownThreats).toEqual([]);
    expect(report.unlinked).toEqual([]);
    expect(report.summary.total).toBe(0);
  });
});
