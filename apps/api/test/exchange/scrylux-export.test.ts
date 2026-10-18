import { ScryluxFileV1 } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { buildScryluxFile, serializeExport } from '../../src/exchange/scrylux-export.js';
import { snapshotOf, us1Model } from './fixtures.js';

// The Scrylux file an export writes (contracts/scrylux-file.md): every key, in a fixed order, records in content order,
// and bytes that change only when the model does (FR-003, FR-005).

const at = new Date('2026-10-10T09:30:00.000Z');
const build = () => buildScryluxFile(snapshotOf(us1Model()), at);

describe('buildScryluxFile', () => {
  it('writes the header and the three arrays, in the contract’s key order', () => {
    const file = build();
    expect(Object.keys(file)).toEqual(['format', 'format_version', 'exported_at', 'project', 'threat_model', 'elements', 'threats', 'mitigations']);
    expect(file.format).toBe('scrylux');
    expect(file.format_version).toBe(1);
    expect(file.exported_at).toBe('2026-10-10T09:30:00.000Z');
    expect(file.project).toEqual({ name: 'Payments' });
    expect(file.threat_model).toEqual({ name: 'Checkout', methodology: 'STRIDE', status: 'in_review' });
  });

  it('writes every key of every record, null where empty, and none the contract leaves out', () => {
    const file = build();
    for (const element of file.elements) {
      expect(Object.keys(element)).toEqual(['id', 'type', 'name', 'properties', 'layout', 'parent_boundary_id', 'source_element_id', 'target_element_id']);
    }
    for (const threat of file.threats) {
      expect(Object.keys(threat)).toEqual([
        'id', 'element_id', 'category', 'title', 'description', 'likelihood', 'impact', 'status', 'status_reason', 'origin', 'library_ref', 'stale',
      ]);
    }
    for (const mitigation of file.mitigations) expect(Object.keys(mitigation)).toEqual(['id', 'threat_id', 'description', 'status', 'external_ref']);
    const text = JSON.stringify(file);
    for (const absent of ['"risk"', 'created_at', 'updated_at', 'created_by', 'threat_model_id', 'project_id']) expect(text).not.toContain(absent);
  });

  it('writes properties as tags (only when there is one) then flags (only the assessed ones)', () => {
    const file = build();
    const byName = (name: string) => file.elements.find((element) => element.name === name);
    expect(byName('API')?.properties).toEqual({ tags: ['Node.js', 'Express'], flags: { handles_sensitive_data: false, internet_facing: true, requires_authentication: true } });
    expect(Object.keys(byName('API')?.properties ?? {})).toEqual(['tags', 'flags']);
    expect(byName('Batch')?.properties).toEqual({});
    expect(byName('Internal network')?.properties).toEqual({});
  });

  it('leaves out empty tags and flags, so an empty list and a missing one export the same', () => {
    const snapshot = snapshotOf(us1Model());
    const first = snapshot.elements.find((element) => element.id === 'p-batch');
    if (first) first.properties = { tags: [], flags: {} };
    expect(buildScryluxFile(snapshot, at).elements.find((element) => element.name === 'Batch')?.properties).toEqual({});
  });

  it('exports what is stored, even outside today’s vocabulary, so a later import can name it', () => {
    const snapshot = snapshotOf(us1Model());
    const api = snapshot.elements.find((element) => element.id === 'p-api');
    if (api) api.properties = { flags: { legacy_flag: true }, zeta: 1, alpha: 2 };
    expect(buildScryluxFile(snapshot, at).elements.find((element) => element.name === 'API')?.properties).toEqual({
      flags: { legacy_flag: true },
      alpha: 2,
      zeta: 1,
    });
  });

  it('writes a layout as x, y, then width and height', () => {
    const file = build();
    expect(Object.keys(file.elements.find((element) => element.name === 'Internal network')?.layout ?? {})).toEqual(['x', 'y', 'width', 'height']);
    expect(file.elements.find((element) => element.name === 'Batch')?.layout).toBeNull();
    expect(file.elements.find((element) => element.type === 'data_flow')?.layout).toBeNull();
  });

  it('keeps stored ids, the stale reason and the origin', () => {
    const file = build();
    expect(file.elements.map((element) => element.id)).toContain('p-api');
    const stale = file.threats.find((threat) => threat.id === 't-rule-2');
    expect(stale?.stale).toEqual({ reason: 'rule_unknown' });
    expect(stale?.origin).toBe('rule');
    expect(stale?.library_ref).toBe('store-unencrypted');
  });

  it('orders records by content, whatever the snapshot’s order or timestamps', () => {
    const forward = snapshotOf(us1Model());
    const backward = snapshotOf(us1Model());
    backward.elements.reverse();
    backward.threats.reverse();
    backward.mitigations.reverse();
    backward.elements.forEach((element, index) => (element.created_at = `2026-10-10T00:00:0${index}.000Z`));
    expect(buildScryluxFile(backward, at)).toEqual(buildScryluxFile(forward, at));
    expect(build().elements.map((element) => element.type)).toEqual([
      'trust_boundary', 'trust_boundary', 'external_entity', 'process', 'process', 'data_store', 'data_flow', 'data_flow',
    ]);
  });

  it('breaks ties by id', () => {
    const snapshot = snapshotOf(us1Model());
    const clone = { ...(snapshot.elements.find((element) => element.id === 'p-batch') as (typeof snapshot.elements)[number]), id: 'p-batch-2' };
    snapshot.elements.push(clone);
    const names = buildScryluxFile(snapshot, at).elements.filter((element) => element.name === 'Batch').map((element) => element.id);
    expect(names).toEqual(['p-batch', 'p-batch-2']);
  });

  it('writes a file the schema accepts', () => {
    expect(ScryluxFileV1.safeParse(build()).success).toBe(true);
  });
});

describe('serializeExport', () => {
  it('writes two-space indentation, \\n line endings and exactly one final newline', () => {
    const text = serializeExport(build());
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(text).not.toContain('\r');
    expect(text.split('\n')[1]).toBe('  "format": "scrylux",');
    expect(JSON.parse(text)).toEqual(build());
  });

  it('differs between two exports of an unchanged model only on the export time line (FR-005)', () => {
    const first = serializeExport(buildScryluxFile(snapshotOf(us1Model()), new Date('2026-10-10T09:30:00.000Z'))).split('\n');
    const second = serializeExport(buildScryluxFile(snapshotOf(us1Model()), new Date('2027-01-02T03:04:05.000Z'))).split('\n');
    expect(second).toHaveLength(first.length);
    const differing = first.flatMap((line, index) => (line === second[index] ? [] : [line.trim().split(':')[0]]));
    expect(differing).toEqual(['"exported_at"']);
  });
});
