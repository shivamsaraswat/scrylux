import { ELEMENT_FLAGS } from '@scrylux/core';
import { shippedLibrary } from '@scrylux/threat-library';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// SC-006 and SC-007: how long a run takes on a typical diagram and on the largest one a threat model can
// hold. In-process against the test database; quickstart §4 repeats the largest through the browser.
describe('generating threats takes a reasonable time (SC-006, SC-007)', () => {
  let server: TestServer;
  let c: V1Client;
  let accountId: number;
  const projects: string[] = [];

  beforeAll(async () => {
    server = await startTestServer(app);
    const token = await login(server.baseUrl);
    accountId = accountIdOf(token);
    c = client(server.baseUrl, token);
  });

  afterAll(async () => {
    // Up to ~15,000 threats under one project: delete it so the shared test database does not fill up.
    for (const id of projects) await c.del(`/projects/${id}`);
    await server.close();
  });

  async function newModel(label: string): Promise<string> {
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName(label) })).body;
    projects.push(project.id);
    expect(accountId).toBeGreaterThan(0);
    return (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body.id;
  }

  // The node type and flag set that give one element the most candidates, found in the shipped library
  // (as the planning research did) so the test cannot pass at a fraction of the load it claims.
  function busiest() {
    const library = shippedLibrary();
    let best = { type: 'process' as 'external_entity' | 'process' | 'data_store', flags: {} as Record<string, boolean>, candidates: 0 };
    for (const type of ['external_entity', 'process', 'data_store'] as const) {
      const names = ELEMENT_FLAGS[type];
      for (let mask = 0; mask < 1 << names.length; mask++) {
        const flags = Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map((name) => [name, true]));
        const candidates = library.candidatesFor({ type, name: 'E', properties: { flags } }).length;
        if (candidates > best.candidates) best = { type, flags, candidates };
      }
    }
    return best;
  }

  const insertElements = (modelId: string, type: string, count: number, properties: unknown) =>
    db.query(
      `INSERT INTO elements (threat_model_id, type, name, properties)
       SELECT $1, $2, 'Element ' || g, $3::jsonb FROM generate_series(1, $4::int) g`,
      [modelId, type, JSON.stringify(properties), count],
    );

  it('generates for a typical 50-element diagram in under 5 seconds (SC-006)', async () => {
    const modelId = await newModel('Typical');
    await insertElements(modelId, 'external_entity', 16, {});
    await insertElements(modelId, 'process', 17, { flags: { internet_facing: true } });
    await insertElements(modelId, 'data_store', 17, {});

    const started = performance.now();
    const res = await c.post<{ created: number }>(`/threat-models/${modelId}/threats/generate`, {});
    const elapsed = performance.now() - started;
    console.log(`SC-006: 50 elements, ${res.body.created} threats created in ${Math.round(elapsed)} ms`);
    expect(res.status).toBe(200);
    expect(res.body.created).toBeGreaterThan(50);
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);

  it('generates for the largest diagram, with the most threats per element, in under 30 seconds, and again for nothing (SC-007)', async () => {
    const { type, flags, candidates } = busiest();
    expect(candidates).toBeGreaterThan(5);
    const modelId = await newModel('Largest');
    await insertElements(modelId, type, 1000, { flags });

    const started = performance.now();
    const first = await c.post<{ created: number; existing: number }>(`/threat-models/${modelId}/threats/generate`, {});
    const elapsed = performance.now() - started;
    console.log(`SC-007: 1000 ${type} elements, ${first.body.created} threats created in ${Math.round(elapsed)} ms`);
    expect(first.status).toBe(200);
    // The count it claims: every element with every candidate. A run that passed on a fraction would fail here.
    expect(first.body.created).toBe(1000 * candidates);
    expect(elapsed).toBeLessThan(30_000);

    const again = await c.post<{ created: number; existing: number }>(`/threat-models/${modelId}/threats/generate`, {});
    expect(again.body).toMatchObject({ created: 0, existing: 1000 * candidates });
  }, 180_000);
});
