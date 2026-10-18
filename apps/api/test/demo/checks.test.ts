import { STRIDE_CATEGORIES } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import type { ExportedFile, ExportedMitigation, ExportedThreat } from '../../src/exchange/scrylux-export.js';
import { checkPatterns } from '../dogfood/checks.js';
import { checkDemoFolder, checkDemoShape, DEMO_FILE, formatDemoFinding, withoutLoopback } from './checks.js';

// Check D4 and D6 of contracts/checks.md: what the demo must contain (spec FR-024) and what its folder may hold (FR-023).
// Each clause is shown to fail on a copy of a small valid file with exactly that clause broken, so none can be a check that
// never fails (Principle II). Messages name a missing kind of thing, never a value the file holds.

const [SPOOFING, TAMPERING, REPUDIATION, DISCLOSURE, DENIAL, ELEVATION] = STRIDE_CATEGORIES;

function threat(id: string, category: ExportedThreat['category'], over: Partial<ExportedThreat> = {}): ExportedThreat {
  return {
    id,
    element_id: 'proc',
    category,
    title: `Threat ${id}`,
    description: 'A threat of the invented system.',
    likelihood: 'Medium',
    impact: 'Medium',
    status: 'open',
    status_reason: null,
    origin: 'rule',
    library_ref: 'rule-ref',
    stale: null,
    ...over,
  };
}

function mitigation(id: string, threatId: string, status: ExportedMitigation['status']): ExportedMitigation {
  return { id, threat_id: threatId, description: `Control ${id}`, status, external_ref: null };
}

// One file that satisfies every clause of FR-024 and is as small as it can be.
function valid(): ExportedFile {
  return {
    format: 'scrylux',
    format_version: 1,
    exported_at: '2026-10-12T00:00:00.000Z',
    project: { name: 'Scrylux demo (fictional)' },
    threat_model: { name: 'Notes app (fictional demo)', methodology: 'STRIDE', status: 'in_review' },
    elements: [
      { id: 'zone', type: 'trust_boundary', name: 'Cloud account', properties: {}, layout: null, parent_boundary_id: null, source_element_id: null, target_element_id: null },
      { id: 'user', type: 'external_entity', name: 'Note taker', properties: { flags: { authenticated: true } }, layout: null, parent_boundary_id: null, source_element_id: null, target_element_id: null },
      { id: 'proc', type: 'process', name: 'Notes API', properties: {}, layout: null, parent_boundary_id: 'zone', source_element_id: null, target_element_id: null },
      { id: 'db', type: 'data_store', name: 'Notes database', properties: {}, layout: null, parent_boundary_id: 'zone', source_element_id: null, target_element_id: null },
      { id: 'flow', type: 'data_flow', name: 'Requests', properties: { flags: { encrypted_in_transit: true } }, layout: null, parent_boundary_id: null, source_element_id: 'user', target_element_id: 'proc' },
    ],
    threats: [
      threat('t1', SPOOFING, { likelihood: 'High', impact: 'High' }),
      threat('t2', TAMPERING, { status: 'mitigated' }),
      threat('t3', REPUDIATION, { status: 'accepted', status_reason: 'Accepted until the audit log exists.', likelihood: 'Low', impact: 'Low' }),
      threat('t4', DISCLOSURE, { status: 'not_applicable', status_reason: 'The store holds no secrets.', likelihood: 'Low', impact: 'Low' }),
      threat('t5', DENIAL),
      threat('t6', ELEVATION, { origin: 'manual', library_ref: null, likelihood: 'High', impact: 'High' }),
    ],
    mitigations: [mitigation('m1', 't2', 'implemented'), mitigation('m2', 't5', 'proposed'), mitigation('m3', 't6', 'verified')],
  };
}

const messages = (data: ExportedFile): string[] => checkDemoShape(DEMO_FILE, data).map((f) => f.message);

describe('checkDemoShape on a file that satisfies FR-024', () => {
  it('finds nothing', () => {
    expect(checkDemoShape(DEMO_FILE, valid())).toEqual([]);
  });
});

describe('checkDemoShape names what is missing', () => {
  it.each([
    ['external_entity', 'no external entity'],
    ['process', 'no process'],
    ['data_store', 'no data store'],
    ['data_flow', 'no data flow'],
    ['trust_boundary', 'no trust boundary'],
  ] as const)('an element type: %s', (type, expected) => {
    const data = valid();
    data.elements = data.elements.filter((e) => e.type !== type);
    expect(messages(data).join('\n')).toContain(expected);
  });

  it('a trust boundary that holds nothing', () => {
    const data = valid();
    data.elements = data.elements.map((e) => ({ ...e, parent_boundary_id: null }));
    expect(messages(data).join('\n')).toContain('no trust boundary holds an element');
  });

  it('no data flow that crosses a trust boundary', () => {
    const data = valid();
    data.elements = data.elements.map((e) => (e.id === 'user' ? { ...e, parent_boundary_id: 'zone' } : e));
    expect(messages(data).join('\n')).toContain('no data flow crosses a trust boundary');
  });

  it('a flow that crosses a boundary but has no flag assessed', () => {
    const data = valid();
    data.elements = data.elements.map((e) => (e.id === 'flow' ? { ...e, properties: {} } : e));
    expect(messages(data).join('\n')).toContain('no data flow that crosses a trust boundary has a security flag set');
  });

  it.each(STRIDE_CATEGORIES.map((c) => [c] as const))('the category %s has no threat', (category) => {
    const data = valid();
    data.threats = data.threats.filter((t) => t.category !== category);
    data.mitigations = data.mitigations.filter((m) => data.threats.some((t) => t.id === m.threat_id));
    expect(messages(data).join('\n')).toContain(`no threat has the category ${category}`);
  });

  it.each(['open', 'mitigated', 'accepted', 'not_applicable'] as const)('no threat is %s', (status) => {
    const data = valid();
    // Move every threat of that status to another one, so that exactly that status is gone.
    data.threats = data.threats.map((t) => {
      if (t.status !== status) return t;
      return status === 'open' ? { ...t, status: 'accepted' as const, status_reason: 'Because.' } : { ...t, status: 'open' as const, status_reason: null };
    });
    expect(messages(data).join('\n')).toContain(`no threat is ${status.replace('_', ' ')}`);
  });

  it.each(['accepted', 'not_applicable'] as const)('a %s threat with no reason', (status) => {
    const data = valid();
    data.threats = data.threats.map((t) => (t.status === status ? { ...t, status_reason: '  ' } : t));
    expect(messages(data).join('\n')).toMatch(/has no reason/);
  });

  it('a mitigated threat with no implemented or verified mitigation', () => {
    const data = valid();
    data.mitigations = data.mitigations.map((m) => (m.id === 'm1' ? { ...m, status: 'proposed' as const } : m));
    expect(messages(data).join('\n')).toContain('mitigated threat');
  });

  it.each(['proposed', 'implemented', 'verified'] as const)('no mitigation is %s', (status) => {
    const data = valid();
    // Re-state each mitigation of that status as one of the others, so that the mitigated threat keeps its supporting control.
    data.mitigations = data.mitigations.map((m) => (m.status === status ? { ...m, status: status === 'implemented' ? ('verified' as const) : ('implemented' as const) } : m));
    expect(messages(data).join('\n')).toContain(`no mitigation is ${status}`);
  });

  it('fewer than three risk levels', () => {
    const data = valid();
    data.threats = data.threats.map((t) => ({ ...t, likelihood: 'Medium' as const, impact: 'Medium' as const }));
    expect(messages(data).join('\n')).toContain('fewer than three risk levels');
  });

  it('no threat of origin rule', () => {
    const data = valid();
    data.threats = data.threats.map((t) => ({ ...t, origin: 'manual' as const }));
    expect(messages(data).join('\n')).toContain('no threat was generated by the rules');
  });

  it('no threat of origin manual', () => {
    const data = valid();
    data.threats = data.threats.map((t) => ({ ...t, origin: 'rule' as const }));
    expect(messages(data).join('\n')).toContain('no threat was written by hand');
  });

  it('a threat of origin ai', () => {
    const data = valid();
    data.threats = data.threats.map((t) => (t.id === 't1' ? { ...t, origin: 'ai' as const } : t));
    expect(messages(data).join('\n')).toContain('AI-drafted');
  });

  it('a project name that does not say the demo is fictional', () => {
    const data = valid();
    data.project = { name: 'Scrylux demo' };
    expect(messages(data).join('\n')).toContain('the project name does not say that the demo is fictional');
  });

  it('a threat model name that does not say the demo is fictional', () => {
    const data = valid();
    data.threat_model = { ...data.threat_model, name: 'Notes app' };
    expect(messages(data).join('\n')).toContain('the threat model name does not say that the demo is fictional');
  });

  it('a threat model status of draft', () => {
    const data = valid();
    data.threat_model = { ...data.threat_model, status: 'draft' };
    expect(messages(data).join('\n')).toContain('status is draft');
  });
});

describe('what a finding says', () => {
  it('names a threat by its title and never repeats its description or its reason', () => {
    const data = valid();
    data.threats = data.threats.map((t) => (t.id === 't3' ? { ...t, status_reason: '', title: 'The audit trail is missing', description: 'SENSITIVE-DESCRIPTION-12345' } : t));
    const text = checkDemoShape(DEMO_FILE, data)
      .map(formatDemoFinding)
      .join('\n');
    expect(text).toContain('The audit trail is missing');
    expect(text).not.toContain('SENSITIVE-DESCRIPTION-12345');
  });

  it('names the file, the check and the procedure that fixes it', () => {
    const data = valid();
    data.threats = [];
    const [first] = checkDemoShape(DEMO_FILE, data);
    const text = formatDemoFinding(first as NonNullable<typeof first>);
    expect(text).toContain(DEMO_FILE);
    expect(text).toContain('shape');
    expect(text).toContain('docs/demo/README.md');
  });
});

describe('checkDemoFolder (D6)', () => {
  it('accepts the two files', () => {
    expect(checkDemoFolder(['README.md', 'notes-app.scrylux.json'])).toEqual([]);
  });

  it('refuses a third file, naming it', () => {
    const found = checkDemoFolder(['README.md', 'notes-app.scrylux.json', 'report.md']);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('report.md');
  });

  it('refuses a missing file, naming it', () => {
    const found = checkDemoFolder(['README.md']);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('notes-app.scrylux.json');
  });
});

describe('the secret-pattern scan of the release text files (D7)', () => {
  // The quickstart file and the docs say the app is published on 127.0.0.1. That is not an address of a deployment, so it is
  // set aside before the scan; any other address still counts.
  const scan = (text: string) => checkPatterns('docker-compose.release.yml', withoutLoopback(text));

  it('does not count the loopback address, alone or in a ports line', () => {
    expect(scan('published on 127.0.0.1 only')).toEqual([]);
    expect(scan('- "127.0.0.1:${PORT:-3000}:3000"')).toEqual([]);
  });

  it('still counts any other address, including one that merely starts like the loopback address', () => {
    expect(scan('the server is 10.0.0.5')).toHaveLength(1);
    expect(scan('the server is 127.0.0.15')).toHaveLength(1);
    expect(scan('the server is 1127.0.0.1')).toHaveLength(0);
    expect(scan('connect to 8.8.8.8 and 127.0.0.1')).toHaveLength(1);
  });

  it('still counts the other patterns on a line that holds the loopback address', () => {
    expect(scan('127.0.0.1 and someone@example.com')).toHaveLength(1);
  });
});
