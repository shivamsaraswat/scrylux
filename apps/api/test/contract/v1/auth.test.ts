import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../../src/app.js';
import { resourceOperations } from '../../../src/v1/operations.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

describe('authentication on every /api/v1 operation (FR-004, spec Story 1 scenario 7)', () => {
  let server: TestServer;
  let c: V1Client;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
  });

  afterAll(async () => {
    await server.close();
  });

  // Guards against this file passing without checking anything: the contract lists 32 resource
  // operations, Phase 3 Milestone 2 adds the 5 job operations and Milestone 3 the 8 source operations
  // (contracts/http-api.md); the OpenAPI document is covered by openapi.test.ts.
  it('covers all 45 resource operations', () => {
    expect(resourceOperations).toHaveLength(45);
  });

  const call = (method: string, path: string, token: string | null) =>
    fetch(`${server.baseUrl}/api/v1${path}`, {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { Authorization: `Bearer ${token}` }) },
      body: method === 'post' || method === 'patch' ? '{}' : undefined,
    });

  const withRandomId = (path: string) => path.replace(':id', randomUUID());

  it('rejects every operation without a token', async () => {
    for (const op of resourceOperations) {
      const res = await call(op.method, withRandomId(op.path), null);
      expect(res.status, `${op.operationId}`).toBe(401);
      expect(await res.json(), `${op.operationId}`).toEqual({ error: 'Authentication required' });
    }
  });

  it('rejects every operation with a token that is not valid', async () => {
    for (const op of resourceOperations) {
      const res = await call(op.method, withRandomId(op.path), 'not.a.token');
      expect(res.status, `${op.operationId}`).toBe(401);
      expect(await res.json(), `${op.operationId}`).toEqual({ error: 'Invalid or expired token' });
    }
  });

  const secret = () => process.env.JWT_SECRET as string;

  it.each([
    ['a non-numeric sub', { sub: 'abc' }],
    ['no sub', {}],
    ['a sub of zero', { sub: '0' }],
    ['a negative sub', { sub: '-1' }],
    ['a fractional sub', { sub: '1.5' }],
    ['a sub beyond the account id range', { sub: '99999999999' }],
    ['a numeric (not string) sub', { sub: 1 }],
  ])('rejects every operation with a correctly signed token that has %s', async (_label, claims) => {
    const token = jwt.sign({ username: 'x', ...claims }, secret());
    for (const op of resourceOperations) {
      const res = await call(op.method, withRandomId(op.path), token);
      expect(res.status, `${op.operationId}`).toBe(401);
      expect(await res.json(), `${op.operationId}`).toEqual({ error: 'Invalid or expired token' });
    }
  });

  it('rejects an expired token', async () => {
    const token = jwt.sign({ sub: '1', username: 'x' }, secret(), { expiresIn: -10 });
    const res = await call('get', '/projects', token);
    expect(res.status).toBe(401);
  });

  it('writes nothing when it rejects a request', async () => {
    const name = uniqueName('Unauthenticated');
    const res = await fetch(`${server.baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ sub: 'abc' }, secret())}` },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(401);
    // Checked by name: the test database is shared with files running in parallel.
    const after = (await c.get<ApiRecord[]>('/projects')).body;
    expect(after.some((p) => p.name === name)).toBe(false);
  });
});
