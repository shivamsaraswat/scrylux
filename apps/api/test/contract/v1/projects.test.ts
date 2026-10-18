import { ProjectRecord, ThreatModelRecord } from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

describe('/api/v1/projects (FR-001, FR-002, FR-006, FR-008)', () => {
  let server: TestServer;
  let c: V1Client;
  let accountId: number;

  beforeAll(async () => {
    server = await startTestServer(app);
    const token = await login(server.baseUrl);
    accountId = accountIdOf(token);
    c = client(server.baseUrl, token);
  });

  afterAll(async () => {
    await server.close();
  });

  async function createProject(prefix = 'Project'): Promise<ApiRecord> {
    const res = await c.post<ApiRecord>('/projects', { name: uniqueName(prefix) });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('creates a project owned by the signed-in account, with an empty description by default', async () => {
    const name = uniqueName('Payments');
    const res = await c.post('/projects', { name });
    expect(res.status).toBe(201);
    const project = ProjectRecord.parse(res.body);
    expect(project).toMatchObject({ name, description: '', created_by: accountId });
  });

  it('never takes the creator from the request body', async () => {
    const res = await c.post('/projects', { name: uniqueName('Spoof'), created_by: 999 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.stringContaining('unknown field "created_by"') as unknown });
  });

  it('reads one project, and lists it among all projects', async () => {
    const project = await createProject();
    const one = await c.get(`/projects/${project.id}`);
    expect(one.status).toBe(200);
    expect(ProjectRecord.parse(one.body)).toEqual(ProjectRecord.parse(project));

    const list = await c.get<ApiRecord[]>('/projects');
    expect(list.status).toBe(200);
    // The database is shared with other test files, so check containment, not equality.
    expect(ProjectRecord.array().parse(list.body).some((p) => p.id === project.id)).toBe(true);
  });

  it('lists projects oldest first', async () => {
    const [a, b, d] = [await createProject('Order'), await createProject('Order'), await createProject('Order')];
    const list = await c.get<ApiRecord[]>('/projects');
    const ours = list.body.map((p) => p.id).filter((id) => [a, b, d].some((p) => p?.id === id));
    expect(ours).toEqual([a?.id, b?.id, d?.id]);
  });

  it('updates only the fields sent, and advances updated_at', async () => {
    const project = await createProject();
    const res = await c.patch('/projects/' + project.id, { description: 'Card payments' });
    expect(res.status).toBe(200);
    const updated = ProjectRecord.parse(res.body);
    expect(updated.description).toBe('Card payments');
    expect(updated.name).toBe(project.name);
    expect(updated.created_at).toBe(project.created_at);
    expect(Date.parse(updated.updated_at)).toBeGreaterThan(Date.parse(project.updated_at as string));
  });

  it('lists the threat models of one project, oldest first', async () => {
    const project = await createProject();
    const empty = await c.get(`/projects/${project.id}/threat-models`);
    expect(empty).toEqual({ status: 200, body: [] });

    const first = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'First' })).body;
    const second = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Second' })).body;
    const list = await c.get(`/projects/${project.id}/threat-models`);
    expect(list.status).toBe(200);
    expect(ThreatModelRecord.array().parse(list.body).map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it('deletes a project with 204 and an empty body, and it is gone', async () => {
    const project = await createProject();
    const res = await c.del(`/projects/${project.id}`);
    expect(res).toEqual({ status: 204, body: null });
    expect(await c.get(`/projects/${project.id}`)).toEqual({ status: 404, body: { error: 'Project not found' } });
  });

  it('deletes everything inside a project with it (M3 FR-010)', async () => {
    const project = await createProject();
    const model = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Inside' })).body;
    expect((await c.del(`/projects/${project.id}`)).status).toBe(204);
    expect(await c.get(`/threat-models/${model.id}`)).toEqual({
      status: 404,
      body: { error: 'Threat model not found' },
    });
  });
});
