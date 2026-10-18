import { deriveRisk, ScryluxFileV1, type ElementRecord, type MitigationRecord, type ThreatRecord } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { buildScryluxFile } from '../../src/exchange/scrylux-export.js';
import { parseFile } from '../../src/exchange/import/parse.js';
import { checkPlan, type ImportPlan } from '../../src/exchange/import/plan.js';
import { planScrylux } from '../../src/exchange/import/scrylux.js';
import type { Snapshot } from '../../src/snapshot.js';
import { HttpError } from '../../src/v1/errors.js';
import { canonical, snapshotOf, us1Model, type ExchangeFile } from './fixtures.js';

// A Scrylux file becomes a plan with its records, statuses and origins as they are (FR-004, FR-008 to FR-010).

const plan = (file: ExchangeFile): ImportPlan => planScrylux(ScryluxFileV1.parse(file));
const checked = (file: ExchangeFile) => checkPlan(plan(file), { existingNames: [] });

function refusal(run: () => unknown): HttpError {
  try {
    run();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('planScrylux', () => {
  it('plans one model with every record, its place in the file, and no notes', () => {
    const result = plan(us1Model());
    expect(result.notes).toEqual([]);
    expect(result.models).toHaveLength(1);
    const model = result.models[0];
    expect(model?.threatModel).toMatchObject({ name: 'Checkout', methodology: 'STRIDE', status: 'in_review' });
    expect(model?.name_issue).toBeNull();
    expect([model?.elements.length, model?.threats.length, model?.mitigations.length]).toEqual([8, 10, 4]);
    expect(model?.elements[3]?.path).toBe('file.elements.3');
    expect(model?.threats[9]?.path).toBe('file.threats.9');
    expect(model?.mitigations[1]?.path).toBe('file.mitigations.1');
  });

  it('gives every record a new id and remaps every reference once checked', () => {
    const model = checked(us1Model()).models[0];
    const file = us1Model();
    const originalIds = new Set([...file.elements, ...file.threats, ...file.mitigations].map((item) => item.id));
    for (const item of [...(model?.elements ?? []), ...(model?.threats ?? []), ...(model?.mitigations ?? [])]) {
      expect(originalIds.has(item.id)).toBe(false);
      expect(item.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    const api = model?.elements.find((element) => element.name === 'API');
    const flow = model?.elements.find((element) => element.name === 'SQL');
    expect(flow?.source_element_id).toBe(api?.id);
    expect(model?.threats.find((threat) => threat.title === 'Spoofing of API')?.element_id).toBe(api?.id);
  });

  it('keeps generated threats generated, with their rule and stale reason (FR-010)', () => {
    const threats = plan(us1Model()).models[0]?.threats ?? [];
    const stale = threats.find((threat) => threat.id === 't-rule-2');
    expect(stale).toMatchObject({ origin: 'rule', library_ref: 'store-unencrypted', stale: { reason: 'rule_unknown' } });
    expect(threats.filter((threat) => threat.origin === 'manual')).toHaveLength(7);
  });

  it('keeps every status and reason, including the two a user could not create (FR-009)', () => {
    const threats = checked(us1Model()).models[0]?.threats ?? [];
    const by = (title: string) => threats.find((threat) => threat.title === title);
    expect(by('Over-privileged DB account')).toMatchObject({ status: 'accepted', status_reason: null });
    expect(by('Batch input is not checked')).toMatchObject({ status: 'mitigated' });
    expect(by('No audit trail')).toMatchObject({ status: 'accepted', status_reason: 'Risk accepted by the owner' });
    expect(by('Disk fills up')).toMatchObject({ status: 'not_applicable', status_reason: 'Out of scope for this release' });
  });

  it('ignores the export time and the project name', () => {
    const other = us1Model();
    other.exported_at = '2030-01-01T00:00:00.000Z';
    other.project.name = 'Another project';
    expect(plan(other)).toEqual(plan(us1Model()));
  });

  it('refuses an AI-drafted threat, naming it (FR-010)', () => {
    const file = us1Model();
    (file.threats[3] as { origin: string }).origin = 'ai';
    const err = refusal(() => plan(file));
    expect(err.status).toBe(400);
    expect(err.message).toBe('file.threats.3.origin: AI-drafted threats cannot be imported yet');
  });

  it('refuses a file stored before today’s rules, naming the element and the field (spec edge case)', () => {
    const file = us1Model();
    (file.elements[3] as { properties: unknown }).properties = { flags: { legacy_flag: true } };
    const err = refusal(() => parseFile('scrylux', file));
    expect(err.status).toBe(400);
    expect(err.message).toBe("file.elements.3: properties: unknown flag");
  });

  it('round-trips in memory: plan, check, export again, and compare once ids are mapped (FR-004)', () => {
    const original = buildScryluxFile(snapshotOf(us1Model()), new Date('2026-10-10T09:30:00.000Z'));
    const again = buildScryluxFile(snapshotFromPlan(checked(original as unknown as ExchangeFile)), new Date('2030-01-01T00:00:00.000Z'));
    expect(canonical(again as unknown as ExchangeFile)).toEqual(canonical(original as unknown as ExchangeFile));
  });
});

// The plan as the snapshot an export would read once stored: every row gets the same created_at, as one import's do.
function snapshotFromPlan(value: ImportPlan): Snapshot {
  const model = value.models[0];
  if (model === undefined) throw new Error('no model');
  const stamps = { created_at: '2026-10-10T10:00:00.000Z', updated_at: '2026-10-10T10:00:00.000Z' };
  const elements: ElementRecord[] = model.elements.map(({ path: _path, depth: _depth, ...row }) => ({ ...row, ...stamps, threat_model_id: model.threatModel.id }));
  const threats: ThreatRecord[] = model.threats.map(({ path: _path, ...row }) => ({
    ...row,
    ...stamps,
    threat_model_id: model.threatModel.id,
    risk: deriveRisk(row.likelihood, row.impact),
  }));
  const mitigations: MitigationRecord[] = model.mitigations.map(({ path: _path, ...row }) => ({ ...row, ...stamps }));
  return {
    model: { id: model.threatModel.id, project_id: 'project', name: model.threatModel.name, methodology: model.threatModel.methodology, status: model.threatModel.status, ...stamps },
    project: { name: 'Another' },
    elements,
    threats,
    mitigations,
  };
}
