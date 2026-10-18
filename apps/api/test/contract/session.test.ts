import { createHash } from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app, { createApp } from '../../src/app.js';
import db from '../../src/db.js';
import { startTestServer, type TestServer } from './helpers.js';
import { captureSessionLog, createTestAccount, sessionRequest, signIn } from './session-helpers.js';

// Browser sessions: contracts/session-api.md. Every test that ends sessions uses its own account.
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const sidOf = (accessToken: string): string => (jwt.decode(accessToken) as { sid: string }).sid;

interface SessionRow {
  current_hash: Buffer;
  previous_hash: Buffer | null;
  ended_at: Date | null;
  end_reason: string | null;
  expires_at: Date;
  created_at: Date;
}

async function row(sid: string): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>('SELECT * FROM browser_sessions WHERE id = $1', [sid]);
  const found = rows[0];
  if (!found) throw new Error('no such session');
  return found;
}

async function rotatedLongAgo(sid: string): Promise<void> {
  await db.query(`UPDATE browser_sessions SET rotated_at = now() - interval '31 seconds' WHERE id = $1`, [sid]);
}

describe('POST /api/session (sign in)', () => {
  it('answers 200 with an access token and sets the session cookie', async () => {
    const account = await createTestAccount(server.baseUrl);
    const res = await sessionRequest(server.baseUrl, '', { body: account });

    expect(res.status).toBe(200);
    expect(res.body.account.username).toBe(account.username);
    expect(Number.isInteger(res.body.account.id)).toBe(true);
    const claims = jwt.decode(res.body.access_token) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: String(res.body.account.id), aud: 'scrylux-ui' });
    expect(typeof claims.sid).toBe('string');
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    const secondsAhead = (new Date(res.body.expires_at).getTime() - Date.now()) / 1000;
    expect(secondsAhead).toBeGreaterThan(240);
    expect(secondsAhead).toBeLessThanOrEqual(300);
  });

  it('sets a 43-character HttpOnly, SameSite=Strict cookie scoped to /api/session, with no Domain', async () => {
    const account = await createTestAccount(server.baseUrl);
    const res = await sessionRequest(server.baseUrl, '', { body: account });
    const cookie = res.setCookie;

    expect(cookie?.name).toBe('scrylux_session');
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie?.attributes.httponly).toBe(true);
    expect(cookie?.attributes.samesite).toBe('Strict');
    expect(cookie?.attributes.path).toBe('/api/session');
    expect(cookie?.attributes).not.toHaveProperty('domain');
    const maxAge = Number(cookie?.attributes['max-age']);
    expect(maxAge).toBeGreaterThan(30 * 86_400 - 120);
    expect(maxAge).toBeLessThanOrEqual(30 * 86_400);
  });

  it('adds Secure only when the request is HTTPS, judged by its Origin', async () => {
    const account = await createTestAccount(server.baseUrl);
    const plain = await sessionRequest(server.baseUrl, '', { body: account });
    expect(plain.setCookie?.attributes).not.toHaveProperty('secure');

    const https = await sessionRequest(server.baseUrl, '', {
      body: account,
      origin: server.baseUrl.replace('http://', 'https://'),
    });
    expect(https.status).toBe(200);
    expect(https.setCookie?.attributes.secure).toBe(true);
  });

  it('stores only the SHA-256 digest of the cookie', async () => {
    const account = await createTestAccount(server.baseUrl);
    const { cookie, accessToken } = await signIn(server.baseUrl, account);
    const stored = await row(sidOf(accessToken));
    expect(stored.current_hash.equals(sha256(cookie))).toBe(true);
    expect(stored.current_hash.equals(Buffer.from(cookie))).toBe(false);
    expect(stored.previous_hash).toBeNull();
  });

  it('answers 400 when the username or password is missing', async () => {
    for (const body of [{}, { username: 'x' }, { password: 'x' }, { username: 5, password: 'x' }]) {
      const res = await sessionRequest(server.baseUrl, '', { body });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'username and password are required' });
      expect(res.setCookie).toBeNull();
    }
  });

  it('answers 401 for a wrong password, with no cookie', async () => {
    const account = await createTestAccount(server.baseUrl);
    const res = await sessionRequest(server.baseUrl, '', { body: { ...account, password: 'definitely-wrong' } });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(res.setCookie).toBeNull();
  });
});

describe.each(['', '/refresh', '/logout', '/logout-all'])('POST /api/session%s guards', (path) => {
  it('answers 403 Forbidden without an Origin header', async () => {
    const res = await sessionRequest(server.baseUrl, path, { origin: null });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it.each(['http://evil.example', 'null', 'http://127.0.0.1:1'])('answers 403 for the foreign Origin %s', async (origin) => {
    const res = await sessionRequest(server.baseUrl, path, { origin });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('answers 415 for a body that is not JSON', async () => {
    const res = await sessionRequest(server.baseUrl, path, { contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Unsupported Media Type' });
  });

  it('answers a GET with 404', async () => {
    const res = await sessionRequest(server.baseUrl, path, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('POST /api/session/refresh', () => {
  it('rotates the credential and answers a new access token', async () => {
    const account = await createTestAccount(server.baseUrl);
    const first = await signIn(server.baseUrl, account);

    const res = await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });

    expect(res.status).toBe(200);
    expect(res.body.account).toEqual({ id: first.body.account.id, username: account.username });
    expect(sidOf(res.body.access_token)).toBe(sidOf(first.accessToken));
    expect(res.setCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.setCookie?.value).not.toBe(first.cookie);
    const stored = await row(sidOf(first.accessToken));
    expect(stored.current_hash.equals(sha256(res.setCookie?.value ?? ''))).toBe(true);
    expect(stored.previous_hash?.equals(sha256(first.cookie))).toBe(true);
  });

  it('survives two concurrent renewals with one cookie: one rotates, the other is a grace hit', async () => {
    const account = await createTestAccount(server.baseUrl);
    const first = await signIn(server.baseUrl, account);

    const [a, b] = await Promise.all([
      sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie }),
      sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    const winners = [a, b].filter((r) => r.setCookie && r.setCookie.value !== '');
    expect(winners).toHaveLength(1);
    expect((await row(sidOf(first.accessToken))).ended_at).toBeNull();
    const next = await sessionRequest(server.baseUrl, '/refresh', { cookie: winners[0]?.setCookie?.value });
    expect(next.status).toBe(200);
  });

  it('treats the replaced credential inside the grace window as a grace hit: 200 and no Set-Cookie', async () => {
    const account = await createTestAccount(server.baseUrl);
    const first = await signIn(server.baseUrl, account);
    await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });

    const grace = await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });

    expect(grace.status).toBe(200);
    expect(grace.setCookie).toBeNull();
    expect(grace.body.access_token).toEqual(expect.any(String));
  });

  it('ends the session when the replaced credential is replayed after the grace window (reuse)', async () => {
    const account = await createTestAccount(server.baseUrl);
    const first = await signIn(server.baseUrl, account);
    const sid = sidOf(first.accessToken);
    const rotated = await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });
    await rotatedLongAgo(sid);

    const replay = await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });

    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Session ended' });
    expect(replay.setCookie?.attributes['max-age']).toBe('0');
    expect((await row(sid)).end_reason).toBe('reuse');
    const current = await sessionRequest(server.baseUrl, '/refresh', { cookie: rotated.setCookie?.value });
    expect(current.status).toBe(401);
  });

  it.each([
    ['no cookie', undefined],
    ['a cookie that matches nothing', 'A'.repeat(43)],
    ['a malformed cookie', 'not a credential'],
  ])('answers 401 and clears the cookie for %s', async (_label, cookie) => {
    const res = await sessionRequest(server.baseUrl, '/refresh', { cookie });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Session ended' });
    expect(res.setCookie?.attributes['max-age']).toBe('0');
  });
});

describe('POST /api/session/logout', () => {
  it('ends the session, clears the cookie and answers 204; doing it again is also 204', async () => {
    const account = await createTestAccount(server.baseUrl);
    const { cookie, accessToken } = await signIn(server.baseUrl, account);

    const res = await sessionRequest(server.baseUrl, '/logout', { cookie });

    expect(res.status).toBe(204);
    expect(res.setCookie?.attributes['max-age']).toBe('0');
    expect((await row(sidOf(accessToken))).end_reason).toBe('logout');
    expect((await sessionRequest(server.baseUrl, '/logout', { cookie })).status).toBe(204);
    expect((await sessionRequest(server.baseUrl, '/refresh', { cookie })).status).toBe(401);
  });

  it('also works with the previous credential, inside the grace window', async () => {
    const account = await createTestAccount(server.baseUrl);
    const first = await signIn(server.baseUrl, account);
    await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });

    const res = await sessionRequest(server.baseUrl, '/logout', { cookie: first.cookie });

    expect(res.status).toBe(204);
    expect((await row(sidOf(first.accessToken))).end_reason).toBe('logout');
  });

  it('answers 204 and clears the cookie even without one', async () => {
    const res = await sessionRequest(server.baseUrl, '/logout');
    expect(res.status).toBe(204);
    expect(res.setCookie?.attributes['max-age']).toBe('0');
  });
});

describe('POST /api/session/logout-all', () => {
  it('ends every session of the account and none of another account’s', async () => {
    const account = await createTestAccount(server.baseUrl);
    const other = await createTestAccount(server.baseUrl);
    const one = await signIn(server.baseUrl, account);
    const two = await signIn(server.baseUrl, account);
    const bystander = await signIn(server.baseUrl, other);

    const res = await sessionRequest(server.baseUrl, '/logout-all', { cookie: one.cookie });

    expect(res.status).toBe(204);
    expect(res.setCookie?.attributes['max-age']).toBe('0');
    for (const session of [one, two]) {
      const stored = await row(sidOf(session.accessToken));
      expect(stored.end_reason).toBe('logout_all');
      expect(stored.ended_at).not.toBeNull();
    }
    expect((await row(sidOf(bystander.accessToken))).ended_at).toBeNull();
    expect((await sessionRequest(server.baseUrl, '/refresh', { cookie: bystander.cookie })).status).toBe(200);
  });

  it('accepts the previous credential, like logout, so a tab that lost a renewal race still works', async () => {
    const account = await createTestAccount(server.baseUrl);
    const first = await signIn(server.baseUrl, account);
    await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });

    const res = await sessionRequest(server.baseUrl, '/logout-all', { cookie: first.cookie });

    expect(res.status).toBe(204);
    expect((await row(sidOf(first.accessToken))).end_reason).toBe('logout_all');
  });

  it('answers 401 for a dead or missing credential', async () => {
    const account = await createTestAccount(server.baseUrl);
    const { cookie } = await signIn(server.baseUrl, account);
    await sessionRequest(server.baseUrl, '/logout', { cookie });

    for (const credential of [cookie, undefined, 'B'.repeat(43)]) {
      const res = await sessionRequest(server.baseUrl, '/logout-all', { cookie: credential });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Session ended' });
    }
  });
});

describe('a replaced credential presented long after its replacement, on logout', () => {
  it('ends the session as reuse and logs it as such, still answering 204', async () => {
    const account = await createTestAccount(server.baseUrl);
    const first = await signIn(server.baseUrl, account);
    const sid = sidOf(first.accessToken);
    await sessionRequest(server.baseUrl, '/refresh', { cookie: first.cookie });
    await rotatedLongAgo(sid);
    const log = captureSessionLog();

    const res = await sessionRequest(server.baseUrl, '/logout', { cookie: first.cookie });
    const lines = log.lines().filter((l) => l.session_id === sid);
    log.restore();

    expect(res.status).toBe(204);
    expect((await row(sid)).end_reason).toBe('reuse');
    expect(lines).toEqual([{ event: 'session', action: 'ended', reason: 'reuse', account_id: first.body.account.id, session_id: sid }]);
  });

  it('still ends every session on sign out everywhere, recording the matched one as reuse', async () => {
    const account = await createTestAccount(server.baseUrl);
    const stolen = await signIn(server.baseUrl, account);
    const other = await signIn(server.baseUrl, account);
    const sid = sidOf(stolen.accessToken);
    await sessionRequest(server.baseUrl, '/refresh', { cookie: stolen.cookie });
    await rotatedLongAgo(sid);
    const log = captureSessionLog();

    const res = await sessionRequest(server.baseUrl, '/logout-all', { cookie: stolen.cookie });
    const lines = log.lines().filter((l) => l.account_id === stolen.body.account.id);
    log.restore();

    expect(res.status).toBe(204);
    expect((await row(sid)).end_reason).toBe('reuse');
    expect((await row(sidOf(other.accessToken))).end_reason).toBe('logout_all');
    expect(lines).toEqual([
      { event: 'session', action: 'ended', reason: 'reuse', account_id: stolen.body.account.id, session_id: sid },
      { event: 'session', action: 'logout_all', account_id: stolen.body.account.id, session_id: sid, sessions_ended: 2 },
    ]);
  });
});

// A reverse proxy that rewrites Host (nginx without `proxy_set_header Host $host`) must not break
// sign-in, but only a trusted proxy may say what the original host was.
describe('the Origin check behind a proxy that rewrites Host', () => {
  const PUBLIC_HOST = 'app.example.test';

  function post(target: TestServer, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${target.baseUrl}/api/session/logout`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2', ...headers } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end('{}');
    });
  }

  const rewritten = { Host: 'internal.local:8080', 'X-Forwarded-Host': PUBLIC_HOST, Origin: `http://${PUBLIC_HOST}` };

  it('accepts the original host from a trusted proxy', async () => {
    const trusted = await startTestServer(createApp({ trustProxy: 'loopback' }));
    try {
      expect(await post(trusted, rewritten)).toBe(204);
    } finally {
      await trusted.close();
    }
  });

  it('ignores X-Forwarded-Host when no proxy is trusted, so a client cannot choose the host', async () => {
    expect(await post(server, rewritten)).toBe(403);
  });

  it('still refuses a foreign Origin behind a trusted proxy', async () => {
    const trusted = await startTestServer(createApp({ trustProxy: 'loopback' }));
    try {
      expect(await post(trusted, { ...rewritten, Origin: 'http://evil.example' })).toBe(403);
    } finally {
      await trusted.close();
    }
  });
});
