import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IMPORT_MAX_BYTES, ScryluxFileV1 } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { buildScryluxFile } from '../../../src/exchange/scrylux-export.js';
import { ajvDraft07 } from '../../exchange/ajv.js';
import { canonical, hostile, snapshotOf, scryluxBody, us1Model, type ExchangeFile } from '../../exchange/fixtures.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { seedUs1Model, type SeededUs1 } from './exchange-helpers.js';
import { captureWriteLog, client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// contracts/exchange-api.md: the export, check and import operations, for the Scrylux file (US1).

interface Summary {
  models: { name: string; name_issue: string | null; status: string; elements: number; threats: number; mitigations: number }[];
  notes: unknown[];
}
interface ImportResultBody {
  threat_models: ApiRecord[];
  summary: Summary;
}

describe('exporting and importing a threat model (Scrylux file)', () => {
  let server: TestServer;
  let token: string;
  let c: V1Client;
  let seeded: SeededUs1;

  const exportOf = (id: string, query = '?format=scrylux', bearer: string | null = token) =>
    fetch(`${server.baseUrl}/api/v1/threat-models/${id}/export${query}`, { headers: bearer === null ? {} : { Authorization: `Bearer ${bearer}` } });
  const exportFile = async (id: string): Promise<ExchangeFile> => (await (await exportOf(id)).json()) as ExchangeFile;
  const check = (projectId: string, body: unknown) => c.post<Summary>(`/projects/${projectId}/imports/check`, body);
  const importInto = (projectId: string, body: unknown) => c.post<ImportResultBody>(`/projects/${projectId}/imports`, body);
  const newProject = async (): Promise<string> => (await c.post<ApiRecord>('/projects', { name: uniqueName('Target') })).body.id;
  const modelsOf = async (projectId: string): Promise<ApiRecord[]> => (await c.get<ApiRecord[]>(`/projects/${projectId}/threat-models`)).body;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
    c = client(server.baseUrl, token);
    seeded = await seedUs1Model(c);
  });

  afterAll(async () => {
    await server.close();
  });

  describe('GET /threat-models/{id}/export', () => {
    it('sends the Scrylux file as a no-store attachment named after the model and the date', async () => {
      const res = await exportOf(seeded.modelId);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.scrylux\.json"$/);
      const text = await res.text();
      expect(text.endsWith('}\n')).toBe(true);
      expect(ScryluxFileV1.safeParse(JSON.parse(text)).success).toBe(true);
    });

    it('holds no account name, account id or credential', async () => {
      const text = JSON.stringify(await exportFile(seeded.modelId));
      expect(text).not.toContain('created_by');
      expect(text).not.toContain(token);
    });

    it('answers 400 for another format, naming the formats there are, and 404 for a missing model', async () => {
      const bad = await exportOf(seeded.modelId, '?format=xml');
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'format must be scrylux or otm' });
      const missing = await exportOf(randomUUID());
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'Threat model not found' });
    });

    it('checks the id, then the format, then whether the model exists', async () => {
      expect(await (await exportOf('not-a-uuid', '?format=bad')).json()).toEqual({ error: 'Invalid id' });
      expect(await (await exportOf(randomUUID(), '?format=bad')).json()).toEqual({ error: 'format must be scrylux or otm' });
    });

    it('needs a token', async () => {
      expect((await exportOf(seeded.modelId, '?format=scrylux', null)).status).toBe(401);
    });

    it('is the same file twice, apart from the export time (FR-005)', async () => {
      const first = (await (await exportOf(seeded.modelId)).text()).split('\n');
      const second = (await (await exportOf(seeded.modelId)).text()).split('\n');
      const differing = first.flatMap((line, index) => (line === second[index] ? [] : [line.trim().split(':')[0]]));
      expect(second).toHaveLength(first.length);
      expect(differing.every((key) => key === '"exported_at"')).toBe(true);
    });
  });

  describe('the round trip (SC-001, FR-004)', () => {
    it('gives the same file back once ids are mapped, and generation then creates nothing', async () => {
      const original = await exportFile(seeded.modelId);
      const target = await newProject();
      const imported = await importInto(target, scryluxBody(original));
      expect(imported.status).toBe(201);
      const created = imported.body.threat_models[0]?.id as string;
      const again = await exportFile(created);
      expect(canonical(again)).toEqual(canonical(original));
      const generation = await c.post<{ created: number }>(`/threat-models/${created}/threats/generate`, {});
      expect(generation.body.created).toBe(0);
    });

    it('keeps every status, including an accepted threat with no reason and a mitigated one with no implemented mitigation (FR-009)', async () => {
      const original = await exportFile(seeded.modelId);
      const imported = await importInto(await newProject(), scryluxBody(original));
      const threats = (await c.get<ApiRecord[]>(`/threat-models/${imported.body.threat_models[0]?.id as string}/threats`)).body;
      const by = (title: string) => threats.find((threat) => threat.title === title);
      expect(by('Over-privileged DB account')).toMatchObject({ status: 'accepted', status_reason: null });
      expect(by('Batch input is not checked')).toMatchObject({ status: 'mitigated' });
      expect(by('No audit trail')).toMatchObject({ status: 'accepted', status_reason: 'Risk accepted by the owner' });
      expect(threats.filter((threat) => threat.origin === 'rule').length).toBeGreaterThan(0);
      expect(threats.some((threat) => (threat.stale as { reason?: string } | null)?.reason === 'rule_unknown')).toBe(true);
    });

    it('makes independent models of the same file imported twice', async () => {
      const original = await exportFile(seeded.modelId);
      const target = await newProject();
      const first = await importInto(target, scryluxBody(original, ['One']));
      const second = await importInto(target, scryluxBody(original, ['Two']));
      expect([first.status, second.status]).toEqual([201, 201]);
      const [a, b] = [first.body.threat_models[0]?.id as string, second.body.threat_models[0]?.id as string];
      const threatsA = (await c.get<ApiRecord[]>(`/threat-models/${a}/threats`)).body;
      await c.patch(`/threats/${threatsA[0]?.id as string}`, { title: 'Changed in one only' });
      const threatsB = (await c.get<ApiRecord[]>(`/threat-models/${b}/threats`)).body;
      expect(threatsB.some((threat) => threat.title === 'Changed in one only')).toBe(false);
    });
  });

  describe('checking, then importing (FR-006b, FR-016)', () => {
    it('answers the check with the summary, creates nothing, and gives the import the same summary', async () => {
      const original = await exportFile(seeded.modelId);
      const target = await newProject();
      const checked = await check(target, scryluxBody(original));
      expect(checked.status).toBe(200);
      expect(checked.body).toEqual({
        models: [
          {
            name: original.threat_model.name,
            name_issue: null,
            status: 'in_review',
            elements: original.elements.length,
            threats: original.threats.length,
            mitigations: original.mitigations.length,
          },
        ],
        notes: [],
      });
      expect(await modelsOf(target)).toEqual([]);
      const imported = await importInto(target, scryluxBody(original));
      expect(imported.status).toBe(201);
      expect(imported.body.summary).toEqual(checked.body);
      expect((await modelsOf(target)).map((model) => model.name)).toEqual([original.threat_model.name]);
    });

    it('reports a name already used in the project, and the import then answers 409 until the name is changed (spec US1 scenario 6)', async () => {
      const original = await exportFile(seeded.modelId);
      const same = await check(seeded.projectId, scryluxBody(original));
      expect(same.status).toBe(200);
      expect(same.body.models[0]?.name_issue).toBe('taken');
      const refused = await importInto(seeded.projectId, scryluxBody(original));
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: 'threat_model.name: a threat model with this name already exists in this project' });
      const renamed = await importInto(seeded.projectId, scryluxBody(original, [uniqueName('Copy')]));
      expect(renamed.status).toBe(201);
    });

    it('refuses names of the wrong count, an empty name and two equal names', async () => {
      const original = await exportFile(seeded.modelId);
      const target = await newProject();
      expect((await importInto(target, scryluxBody(original, ['A', 'B']))).body).toEqual({ error: 'names: must have 1 entry, one per threat model in the file' });
      expect((await importInto(target, scryluxBody(original, ['  ']))).body).toEqual({ error: 'names.0: must not be empty' });
      expect((await check(target, scryluxBody(original, ['  ']))).body.models[0]?.name_issue).toBe('empty');
    });
  });

  describe('refusing a file (FR-015, SC-004)', () => {
    it('creates nothing when the last mitigation breaks a rule, and names its place', async () => {
      const original = await exportFile(seeded.modelId);
      const broken = JSON.parse(JSON.stringify(original)) as ExchangeFile;
      const last = broken.mitigations.length - 1;
      (broken.mitigations[last] as { external_ref: string | null }).external_ref = 'ftp://x';
      const target = await newProject();
      const res = await importInto(target, scryluxBody(broken));
      expect(res.status).toBe(400);
      expect((res.body as unknown as { error: string }).error).toMatch(new RegExp(`^file\\.mitigations\\.${last}\\.external_ref: `));
      expect(await modelsOf(target)).toEqual([]);
    });

    it('refuses a dangling reference and a threat reason on an open threat, with their places', async () => {
      const original = await exportFile(seeded.modelId);
      const dangling = JSON.parse(JSON.stringify(original)) as ExchangeFile;
      (dangling.elements.find((element) => element.type === 'data_flow') as { source_element_id: string | null }).source_element_id = 'nope';
      const flow = dangling.elements.findIndex((element) => element.type === 'data_flow');
      const res = await check(await newProject(), scryluxBody(dangling));
      expect(res.status).toBe(400);
      expect((res.body as unknown as { error: string }).error).toBe(`file.elements.${flow}.source_element_id: must refer to an external entity, process or data store in this file`);

      const reason = JSON.parse(JSON.stringify(original)) as ExchangeFile;
      const open = reason.threats.findIndex((threat) => threat.status === 'open');
      (reason.threats[open] as { status_reason: string | null }).status_reason = 'why';
      const res2 = await importInto(await newProject(), scryluxBody(reason));
      expect((res2.body as unknown as { error: string }).error).toBe(`file.threats.${open}.status_reason: can only be set on a threat that is accepted or not_applicable`);
    });

    it('refuses an AI-drafted threat in the check and in the import (FR-010)', async () => {
      const original = await exportFile(seeded.modelId);
      const ai = JSON.parse(JSON.stringify(original)) as ExchangeFile;
      (ai.threats[0] as { origin: string }).origin = 'ai';
      const target = await newProject();
      for (const operation of [check, importInto]) {
        const res = await operation(target, scryluxBody(ai));
        expect(res.status).toBe(400);
        expect((res.body as unknown as { error: string }).error).toBe('file.threats.0.origin: AI-drafted threats cannot be imported yet');
      }
      expect(await modelsOf(target)).toEqual([]);
    });

    it('answers 404 for a project that is gone, between the check and the import', async () => {
      const original = await exportFile(seeded.modelId);
      const target = await newProject();
      expect((await check(target, scryluxBody(original))).status).toBe(200);
      await c.del(`/projects/${target}`);
      const res = await importInto(target, scryluxBody(original));
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Project not found' });
    });

    it('answers 400 for a file in the wrong format, and refuses a file of another version', async () => {
      const target = await newProject();
      const wrong = await check(target, { format: 'scrylux', file: { hello: 1 } });
      expect(wrong.status).toBe(400);
      const original = await exportFile(seeded.modelId);
      const version = await check(target, scryluxBody({ ...original, format_version: 2 } as unknown as ExchangeFile));
      expect((version.body as unknown as { error: string }).error).toBe('file.format_version: must be 1; this file is version 2');
    });
  });

  describe('bounds (FR-020)', () => {
    it('refuses a file nested too deep, and one with too many values, before reading it', async () => {
      const target = await newProject();
      let deep: unknown = 1;
      for (let level = 0; level < 65; level += 1) deep = { next: deep };
      const tooDeep = await check(target, { format: 'scrylux', file: deep });
      expect(tooDeep).toEqual({ status: 400, body: { error: 'file: nested more than 64 levels deep' } });
      const tooMany = await check(target, { format: 'scrylux', file: { values: new Array<number>(2_000_001).fill(0) } });
      expect(tooMany).toEqual({ status: 400, body: { error: 'file: has more than 2,000,000 values' } });
    });

    it('answers 413 to a body over the limit', async () => {
      const target = await newProject();
      const res = await c.raw(`/projects/${target}/imports/check`, { method: 'POST', body: 'x'.repeat(IMPORT_MAX_BYTES + 1) });
      expect(res).toEqual({ status: 413, body: { error: 'Payload too large' } });
    });

    it('answers 401 to a malformed body without a token', async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/projects/${randomUUID()}/imports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"format":',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('the log (FR-017, FR-019)', () => {
    it('writes one import line with ids and counts and no content, and nothing for an export or a check', async () => {
      const SECRET = 'SECRET-MODEL-NAME';
      const original = await exportFile(seeded.modelId);
      original.threat_model.name = SECRET;
      const target = await newProject();
      const log = captureWriteLog();
      try {
        await exportOf(seeded.modelId);
        await check(target, scryluxBody(original));
        expect(log.raw().filter((line) => line.includes('"event":"import"'))).toEqual([]);
        const imported = await importInto(target, scryluxBody(original, [SECRET]));
        const lines = log.raw().filter((line) => line.includes('"event":"import"'));
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] as string)).toEqual({
          event: 'import',
          account_id: expect.any(Number) as unknown,
          project_id: target,
          threat_model_ids: [imported.body.threat_models[0]?.id],
          elements: original.elements.length,
          threats: original.threats.length,
          mitigations: original.mitigations.length,
          notes: 0,
        });
        expect(log.raw().join('\n')).not.toContain(SECRET);
        expect(log.raw().join('\n')).not.toContain(original.threats[0]?.title ?? 'no title');
        expect(log.lines()).toEqual([]);
      } finally {
        log.restore();
      }
    });
  });

  describe('hostile text (FR-018)', () => {
    it('is stored exactly as written, and a report of it holds no live markup', async () => {
      const file = hostile();
      const target = await newProject();
      const imported = await importInto(target, scryluxBody(file));
      expect(imported.status).toBe(201);
      const id = imported.body.threat_models[0]?.id as string;
      const threats = (await c.get<ApiRecord[]>(`/threat-models/${id}/threats`)).body;
      expect(threats.map((threat) => threat.title).sort()).toEqual(file.threats.map((threat) => threat.title).sort());
      const mitigations = (await c.get<ApiRecord[]>(`/threat-models/${id}/mitigations`)).body;
      expect(mitigations.map((mitigation) => mitigation.description).sort()).toEqual(file.mitigations.map((mitigation) => mitigation.description).sort());
      const report = await (await fetch(`${server.baseUrl}/api/v1/threat-models/${id}/report?format=html`, { headers: { Authorization: `Bearer ${token}` } })).text();
      expect(report).not.toContain('<script>window.__ran');
      expect(report).not.toContain('<img src=x');
    });

    it('comes back whole: every name, tag, description, reason, ticket and the model name as written (FR-018, SC-001)', async () => {
      // What the API stores is the file with its text trimmed, as every create trims it, so that is what must come back.
      const expected = ScryluxFileV1.parse(buildScryluxFile(snapshotOf(hostile()), new Date('2026-10-10T00:00:00.000Z')));
      const imported = await importInto(await newProject(), scryluxBody(hostile()));
      expect(imported.status).toBe(201);
      const again = await exportFile(imported.body.threat_models[0]?.id as string);
      expect(canonical(again)).toEqual(canonical(expected));
      // The hostile strings are really in what was compared: this would pass for empty text too.
      expect(JSON.stringify(again)).toContain('<script>window.__ran = 1</script>');
      expect(again.threat_model.name).toBe(hostile().threat_model.name);
    });
  });

  describe('edge cases of the spec', () => {
    it('imports a model with nothing in it, and exports it again as the same empty model (edge case "Empty model")', async () => {
      const empty: ExchangeFile = { ...us1Model(), elements: [], threats: [], mitigations: [] };
      const target = await newProject();
      const checked = await check(target, scryluxBody(empty));
      expect(checked).toEqual({
        status: 200,
        body: { models: [{ name: empty.threat_model.name, name_issue: null, status: 'in_review', elements: 0, threats: 0, mitigations: 0 }], notes: [] },
      });
      const imported = await importInto(target, scryluxBody(empty));
      expect(imported.status).toBe(201);
      const again = await exportFile(imported.body.threat_models[0]?.id as string);
      expect([again.elements, again.threats, again.mitigations]).toEqual([[], [], []]);
      expect(canonical(again)).toEqual(canonical(empty));
    });

    it('imports two elements of the same name as two elements, each with its own threat (edge case "Names that repeat")', async () => {
      const file = us1Model();
      file.elements = [
        { id: 'w1', type: 'process', name: 'Worker', properties: {}, layout: null, parent_boundary_id: null, source_element_id: null, target_element_id: null },
        { id: 'w2', type: 'process', name: 'Worker', properties: {}, layout: null, parent_boundary_id: null, source_element_id: null, target_element_id: null },
      ];
      file.threats = file.threats.slice(0, 2).map((threat, index) => ({ ...threat, id: `t${index}`, element_id: `w${index + 1}`, origin: 'manual', library_ref: null, stale: null }));
      file.mitigations = [];
      const imported = await importInto(await newProject(), scryluxBody(file));
      expect(imported.status).toBe(201);
      const id = imported.body.threat_models[0]?.id as string;
      const elements = (await c.get<ApiRecord[]>(`/threat-models/${id}/elements`)).body;
      const threats = (await c.get<ApiRecord[]>(`/threat-models/${id}/threats`)).body;
      expect(elements.map((element) => element.name)).toEqual(['Worker', 'Worker']);
      expect(new Set(threats.map((threat) => threat.element_id)).size).toBe(2);
      for (const threat of threats) expect(elements.map((element) => element.id)).toContain(threat.element_id);
    });

    it('keeps a generated threat of a rule this install does not have, and the next generation flags it stale (edge case "Rules this install does not know")', async () => {
      const file = us1Model();
      const unknown = file.threats.find((threat) => threat.id === 't-rule-1');
      expect(unknown).toMatchObject({ origin: 'rule', library_ref: 'process-spoofing', stale: null });
      const imported = await importInto(await newProject(), scryluxBody(file));
      expect(imported.status).toBe(201);
      const id = imported.body.threat_models[0]?.id as string;
      const before = (await c.get<ApiRecord[]>(`/threat-models/${id}/threats`)).body.find((threat) => threat.title === 'Spoofing of API');
      expect(before).toMatchObject({ origin: 'rule', library_ref: 'process-spoofing', stale: null });

      const run = await c.post<{ newly_stale: number }>(`/threat-models/${id}/threats/generate`, {});
      expect(run.status).toBe(200);
      // The two imported rule threats that were not stale are now: its rule is in no library this install has.
      expect(run.body.newly_stale).toBe(2);
      const after = (await c.get<ApiRecord[]>(`/threat-models/${id}/threats`)).body.find((threat) => threat.id === before?.id);
      expect(after).toMatchObject({ title: 'Spoofing of API', status: 'open', origin: 'rule', library_ref: 'process-spoofing', stale: { reason: 'rule_unknown' } });
    });
  });
  describe('OTM (US2)', () => {
    const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../exchange/fixtures/otm/${name}`, import.meta.url)), 'utf8')) as unknown;
    const exportOtm = async (id: string): Promise<Record<string, unknown>> => (await (await exportOf(id, '?format=otm')).json()) as Record<string, unknown>;
    const otmBody = (file: unknown, names?: string[]) => (names === undefined ? { format: 'otm', file } : { format: 'otm', names, file });

    it('exports an OTM file with the same headers, named .otm.json, valid against the OTM schema (SC-002)', async () => {
      const res = await exportOf(seeded.modelId, '?format=otm');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.otm\.json"$/);
      const validate = ajvDraft07().compile(fixture('otm_schema.json') as object);
      const file = (await res.json());
      expect(validate(file), JSON.stringify(validate.errors)).toBe(true);
    });

    it('is the same file twice, apart from the export time (FR-005)', async () => {
      const first = (await (await exportOf(seeded.modelId, '?format=otm')).text()).split('\n');
      const second = (await (await exportOf(seeded.modelId, '?format=otm')).text()).split('\n');
      const differing = first.flatMap((line, index) => (line === second[index] ? [] : [line.trim().split(':')[0]]));
      expect(second).toHaveLength(first.length);
      expect(differing.every((key) => key === '"exported_at"')).toBe(true);
    });

    it('round-trips through OTM with nothing lost: no notes, the same model once ids are mapped, and generation adds nothing (SC-002)', async () => {
      const original = await exportFile(seeded.modelId);
      const otm = await exportOtm(seeded.modelId);
      const target = await newProject();
      const checked = await check(target, otmBody(otm));
      expect(checked.status).toBe(200);
      expect(checked.body.notes).toEqual([]);
      expect(checked.body.models[0]).toMatchObject({ name: original.threat_model.name, status: 'in_review', name_issue: null });
      const imported = await importInto(target, otmBody(otm));
      expect(imported.status).toBe(201);
      const created = imported.body.threat_models[0]?.id as string;
      expect(canonical(await exportFile(created))).toEqual(canonical(original));
      expect((await c.post<{ created: number }>(`/threat-models/${created}/threats/generate`, {})).body.created).toBe(0);
    });

    it('imports another tool’s OTM file, listing what it could not carry over (US2, SC-003)', async () => {
      const target = await newProject();
      const checked = await check(target, otmBody(fixture('EXAMPLE.json')));
      expect(checked.status).toBe(200);
      expect(checked.body.models).toEqual([{ name: 'Test project', name_issue: null, status: 'draft', elements: 8, threats: 2, mitigations: 2 }]);
      expect(checked.body.notes.length).toBeGreaterThan(0);
      const imported = await importInto(target, otmBody(fixture('EXAMPLE.json')));
      expect(imported.status).toBe(201);
      expect(imported.body.summary).toEqual(checked.body);
      const id = imported.body.threat_models[0]?.id as string;
      const threats = (await c.get<ApiRecord[]>(`/threat-models/${id}/threats`)).body;
      expect(threats.map((threat) => threat.origin)).toEqual(['manual', 'manual']);
    });

    it('refuses a file that is not OTM 0.2.0, naming what it reads', async () => {
      const target = await newProject();
      const old = await check(target, otmBody(fixture('mobile-cloud.otm.json')));
      expect(old).toEqual({ status: 400, body: { error: 'file: not an OTM 0.2.0 file' } });
      const other = await check(target, otmBody({ format: 'scrylux' }));
      expect(other).toEqual({ status: 400, body: { error: 'file: not an OTM 0.2.0 file' } });
      expect(await modelsOf(target)).toEqual([]);
    });

    it('holds an edited Scrylux OTM file to the strict rules until it stops claiming to be Scrylux’s', async () => {
      const otm = await exportOtm(seeded.modelId);
      const edited = JSON.parse(JSON.stringify(otm)) as { components: { attributes?: unknown }[]; project: { attributes?: unknown } };
      delete edited.components[0]?.attributes;
      const target = await newProject();
      const strict = await check(target, otmBody(edited));
      expect(strict.status).toBe(400);
      expect((strict.body as unknown as { error: string }).error).toBe(
        "file.components.0.attributes.scrylux: missing; this file was changed outside Scrylux (remove project.attributes.scrylux to import it as another tool's file)",
      );
      delete edited.project.attributes;
      const adapted = await check(target, otmBody(edited));
      expect(adapted.status).toBe(200);
      expect(adapted.body.notes.length).toBeGreaterThan(0);
    });
  });

  describe('Threat Dragon (US3)', () => {
    const demo = (name: string): Record<string, unknown> =>
      JSON.parse(readFileSync(fileURLToPath(new URL(`../../exchange/fixtures/threat-dragon/${name}`, import.meta.url)), 'utf8')) as Record<string, unknown>;
    const tdBody = (file: unknown, names?: string[]) => (names === undefined ? { format: 'threat-dragon', file } : { format: 'threat-dragon', names, file });
    // The generic CMS demo twice, as two diagrams of one file.
    const twoDiagrams = (): Record<string, unknown> => {
      const base = demo('generic-cms.json') as { summary: Record<string, unknown>; detail: { diagrams: Record<string, unknown>[] } };
      const diagrams = [{ ...base.detail.diagrams[0], title: 'Web' }, { ...base.detail.diagrams[0], title: 'Batch' }];
      return { ...base, summary: { ...base.summary, title: `Shop ${randomUUID().slice(0, 8)}` }, detail: { ...base.detail, diagrams } };
    };

    it('checks a demo file: one model, with the notes for what is left out', async () => {
      const checked = await check(await newProject(), tdBody(demo('v2-threat-model.json')));
      expect(checked.status).toBe(200);
      expect(checked.body.models).toEqual([{ name: 'Demo Threat Model', name_issue: null, status: 'draft', elements: 16, threats: 14, mitigations: 14 }]);
      expect(checked.body.notes.length).toBeGreaterThan(0);
    });

    it('imports a demo file: every threat is manual, and a decision is kept as it was', async () => {
      const target = await newProject();
      const imported = await importInto(target, tdBody(demo('v2-threat-model.json')));
      expect(imported.status).toBe(201);
      const id = imported.body.threat_models[0]?.id as string;
      const threats = (await c.get<ApiRecord[]>(`/threat-models/${id}/threats`)).body;
      expect(threats).toHaveLength(14);
      expect(new Set(threats.map((threat) => threat.origin))).toEqual(new Set(['manual']));
      expect(threats.some((threat) => threat.status === 'mitigated')).toBe(true);
      expect((await c.get<ApiRecord[]>(`/threat-models/${id}/elements`)).body).toHaveLength(16);
    });

    it('creates one model per diagram, all in one transaction, named after the file and the diagram', async () => {
      const file = twoDiagrams();
      const title = (file.summary as { title: string }).title;
      const target = await newProject();
      const checked = await check(target, tdBody(file));
      expect(checked.body.models.map((model) => model.name)).toEqual([`${title} – Web`, `${title} – Batch`]);
      expect(checked.body.models.map((model) => model.elements)).toEqual([11, 11]);
      const imported = await importInto(target, tdBody(file));
      expect(imported.status).toBe(201);
      expect(imported.body.threat_models.map((model) => model.name)).toEqual([`${title} – Web`, `${title} – Batch`]);
      expect(imported.body.summary).toEqual(checked.body);
      expect((await modelsOf(target)).map((model) => model.name).sort()).toEqual([`${title} – Batch`, `${title} – Web`]);
    });

    it('creates neither model when the second one’s default name is already taken', async () => {
      const file = twoDiagrams();
      const title = (file.summary as { title: string }).title;
      const target = await newProject();
      await c.post('/threat-models', { project_id: target, name: `${title} – Batch` });
      const checked = await check(target, tdBody(file));
      expect(checked.body.models.map((model) => model.name_issue)).toEqual([null, 'taken']);
      const refused = await importInto(target, tdBody(file));
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: 'names.1: a threat model with this name already exists in this project' });
      expect((await modelsOf(target)).map((model) => model.name)).toEqual([`${title} – Batch`]);
    });

    it('takes one name per model, and refuses the wrong count', async () => {
      const file = twoDiagrams();
      const target = await newProject();
      const wrong = await importInto(target, tdBody(file, ['Only one']));
      expect(wrong).toEqual({ status: 400, body: { error: 'names: must have 2 entries, one per threat model in the file' } });
      const duplicate = await check(target, tdBody(file, ['Same', 'same']));
      expect(duplicate.body.models.map((model) => model.name_issue)).toEqual(['duplicate', 'duplicate']);
      const named = await importInto(target, tdBody(file, ['First', 'Second']));
      expect(named.status).toBe(201);
      expect(named.body.threat_models.map((model) => model.name)).toEqual(['First', 'Second']);
    });

    it('refuses a Threat Dragon version 1 file, and a file that is not Threat Dragon', async () => {
      const target = await newProject();
      const v1 = await check(target, tdBody({ version: '1.0', detail: { diagrams: [{ diagramJson: {} }] } }));
      expect(v1).toEqual({ status: 400, body: { error: 'file: Threat Dragon version 1 files are not supported; open and save the model in Threat Dragon 2 first' } });
      const other = await check(target, tdBody({ format: 'scrylux' }));
      expect(other).toEqual({ status: 400, body: { error: 'file: not a Threat Dragon version 2 file' } });
      expect(await modelsOf(target)).toEqual([]);
    });
  });

});
