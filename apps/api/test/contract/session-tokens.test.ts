import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/app.js';
import config from '../../src/config.js';
import { login, startTestServer, type TestServer } from './helpers.js';
import { createTestAccount, sessionRequest, signIn } from './session-helpers.js';

// The two token types (contracts/session-api.md, "Access tokens on existing routes"). A UI access token
// is limited to /api/v1 and only while its session is active. The /api/login token is unchanged.
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

const UNAUTHORIZED = { error: 'Invalid or expired token' };

async function get(path: string, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

async function postUser(token: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${server.baseUrl}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function forge(payload: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(payload, config.jwtSecret as string, { expiresIn: '5m', algorithm: 'HS256', ...options });
}

describe('a UI access token', () => {
  it('works on /api/v1', async () => {
    const account = await createTestAccount(server.baseUrl);
    const { accessToken } = await signIn(server.baseUrl, account);
    expect((await get('/api/v1/projects', accessToken)).status).toBe(200);
  });

  it('is refused on /api/users, for any method', async () => {
    const account = await createTestAccount(server.baseUrl);
    const { accessToken } = await signIn(server.baseUrl, account);

    const read = await get('/api/users', accessToken);
    expect(read).toEqual({ status: 401, body: UNAUTHORIZED });
    const create = await postUser(accessToken, { username: `m6-test-never-${Date.now()}`, password: 'a-long-password' });
    expect(create).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it('stops working on /api/v1 as soon as the session is logged out, before the token expires', async () => {
    const account = await createTestAccount(server.baseUrl);
    const { accessToken, cookie } = await signIn(server.baseUrl, account);
    expect((await get('/api/v1/projects', accessToken)).status).toBe(200);

    await sessionRequest(server.baseUrl, '/logout', { cookie });

    expect(await get('/api/v1/projects', accessToken)).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it('stops working for every session of the account after sign out everywhere', async () => {
    const account = await createTestAccount(server.baseUrl);
    const one = await signIn(server.baseUrl, account);
    const two = await signIn(server.baseUrl, account);

    await sessionRequest(server.baseUrl, '/logout-all', { cookie: one.cookie });

    for (const { accessToken } of [one, two]) {
      expect(await get('/api/v1/projects', accessToken)).toEqual({ status: 401, body: UNAUTHORIZED });
    }
  });
});

describe('tokens that only look like a UI access token', () => {
  const sub = '1';

  it.each([
    ['audience "scrylux-ui" but no sid', { sub, aud: 'scrylux-ui' }],
    ['another audience', { sub, aud: 'someone-else', sid: '00000000-0000-4000-8000-000000000000' }],
    ['a sid that is not a UUID', { sub, aud: 'scrylux-ui', sid: "1'; DROP TABLE users;--" }],
    ['a sid for a session that does not exist', { sub, aud: 'scrylux-ui', sid: '00000000-0000-4000-8000-000000000000' }],
    ['a numeric sid', { sub, aud: 'scrylux-ui', sid: 5 }],
  ])('is refused on /api/v1 with %s, without a server error', async (_label, payload) => {
    expect(await get('/api/v1/projects', forge(payload))).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it('refuses a token signed with HS512', async () => {
    const token = forge({ sub: '1', username: 'admin' }, { algorithm: 'HS512' });
    expect(await get('/api/v1/projects', token)).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it('refuses an expired token', async () => {
    const token = forge({ sub: '1', username: 'admin' }, { expiresIn: -10 });
    expect(await get('/api/v1/projects', token)).toEqual({ status: 401, body: UNAUTHORIZED });
  });
});

describe('an /api/login bearer token', () => {
  it('works on both /api/v1 and /api/users, as before', async () => {
    const token = await login(server.baseUrl);
    expect((await get('/api/v1/projects', token)).status).toBe(200);
    // An invalid body is answered by the route itself, so it proves the token got through.
    expect(await postUser(token, {})).toEqual({ status: 400, body: { error: 'username is required (max 64 characters)' } });
  });

  it('is not revoked by sign out everywhere, and keeps working until it expires', async () => {
    const account = await createTestAccount(server.baseUrl);
    const bearer = await login(server.baseUrl, account.username, account.password);
    const { cookie } = await signIn(server.baseUrl, account);

    await sessionRequest(server.baseUrl, '/logout-all', { cookie });

    expect((await get('/api/v1/projects', bearer)).status).toBe(200);
  });
});
