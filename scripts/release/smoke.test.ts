import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSmoke, SmokeFailure, type SmokeOptions } from './smoke.js';
import { expectedLabels } from './versions.js';

// The seven steps of contracts/release-pipeline.md ("What `smoke` checks"), against a fake server so that each can be made
// to fail on its own (check S, spec FR-004, SC-003). The fake answers as Specter's API does for the calls the script makes.

const SHA = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '0.1.0';

interface Fake {
  healthy: boolean;
  csp: boolean;
  root: boolean;
  loginOk: boolean;
  notes: unknown[];
  importStatus: number;
  created: number;
  newlyStale: number;
  listedStale: boolean;
}

const fresh = (): Fake => ({
  healthy: true,
  csp: true,
  root: true,
  loginOk: true,
  notes: [],
  importStatus: 201,
  created: 0,
  newlyStale: 0,
  listedStale: false,
});

let fake: Fake;
let server: Server;
let baseUrl: string;
let seen: { method: string; url: string; auth: string | undefined; body: string }[];

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const method = req.method ?? '';
    const url = req.url ?? '';
    seen.push({ method, url, auth: req.headers.authorization, body });
    if (method === 'GET' && url === '/health') return json(res, fake.healthy ? 200 : 503, { status: fake.healthy ? 'ok' : 'down' });
    if (method === 'GET' && url === '/') {
      const headers: Record<string, string> = { 'content-type': 'text/html' };
      if (fake.csp) headers['content-security-policy'] = "default-src 'self'";
      res.writeHead(200, headers);
      return void res.end(fake.root ? '<!doctype html><html><body><div id="root"></div></body></html>' : '<html>nginx welcome</html>');
    }
    if (method === 'POST' && url === '/api/login') {
      const { username, password } = JSON.parse(body) as { username: string; password: string };
      return fake.loginOk && username === 'admin' && password === 'admin' ? json(res, 200, { token: 'TOKEN-SECRET' }) : json(res, 401, { error: 'no' });
    }
    if (req.headers.authorization !== 'Bearer TOKEN-SECRET') return json(res, 401, { error: 'sign in first' });
    if (method === 'POST' && url === '/api/v1/projects') return json(res, 201, { id: 'p1' });
    if (method === 'POST' && url === '/api/v1/projects/p1/imports/check') {
      return json(res, 200, { models: [{ name: 'M', name_issue: null, elements: 2, threats: 3, mitigations: 1 }], notes: fake.notes });
    }
    if (method === 'POST' && url === '/api/v1/projects/p1/imports') {
      return fake.importStatus === 201 ? json(res, 201, { threat_models: [{ id: 'm1' }] }) : json(res, fake.importStatus, { error: 'refused' });
    }
    if (method === 'POST' && url === '/api/v1/threat-models/m1/threats/generate') {
      return json(res, 200, { created: fake.created, existing: 3, newly_stale: fake.newlyStale, no_longer_stale: 0, skipped_elements: [] });
    }
    if (method === 'GET' && url === '/api/v1/threat-models/m1/threats') {
      return json(res, 200, [
        { id: 't1', stale: null },
        { id: 't2', stale: fake.listedStale ? { reason: 'rule_retired' } : null },
      ]);
    }
    return json(res, 404, { error: 'not found' });
  });
}

beforeEach(async () => {
  fake = fresh();
  seen = [];
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// A clock that never waits: `sleep` moves the time forward, so the 60 seconds of the health step cost nothing.
function clock() {
  let t = 0;
  return { now: () => t, sleep: (ms: number) => Promise.resolve().then(() => void (t += ms)) };
}

function options(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  return {
    baseUrl,
    demo: { format: 'specter', format_version: 1 },
    version: VERSION,
    sha: SHA,
    labels: expectedLabels({ version: VERSION, sha: SHA }),
    clock: clock(),
    dbReachable: () => Promise.resolve(false),
    log: () => undefined,
    ...overrides,
  };
}

async function failure(overrides: Partial<SmokeOptions> = {}): Promise<SmokeFailure> {
  try {
    await runSmoke(options(overrides));
  } catch (error) {
    if (error instanceof SmokeFailure) return error;
    throw error;
  }
  throw new Error('the smoke run did not fail');
}

describe('a healthy image', () => {
  it('passes all seven steps, in order', async () => {
    const report = await runSmoke(options());
    expect(report.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(report.steps.map((s) => s.name)).toEqual(['health', 'web app', 'sign in', 'demo import', 'generate', 'database port', 'image labels']);
  });

  it('imports the demo file it was given, in a project of its own, with the signed-in token', async () => {
    await runSmoke(options({ demo: { format: 'specter', marker: 'the-demo' } }));
    const check = seen.find((r) => r.url === '/api/v1/projects/p1/imports/check');
    expect(check?.auth).toBe('Bearer TOKEN-SECRET');
    expect(JSON.parse(check?.body ?? '{}')).toEqual({ format: 'specter', file: { format: 'specter', marker: 'the-demo' } });
    expect(seen.some((r) => r.method === 'POST' && r.url === '/api/v1/projects/p1/imports')).toBe(true);
  });

  it('uses the compose defaults to sign in, or the ones it is given', async () => {
    await runSmoke(options());
    expect(JSON.parse(seen.find((r) => r.url === '/api/login')?.body ?? '{}')).toEqual({ username: 'admin', password: 'admin' });
  });
});

describe('each step fails the run by name', () => {
  it('1: health never answers 200', async () => {
    fake.healthy = false;
    const f = await failure();
    expect(f.step).toBe(1);
    expect(f.message).toMatch(/^smoke step 1 \(health\): /);
    expect(f.message).toMatch(/60 seconds/);
  });

  it('1: health that comes up late still passes within the 60 seconds', async () => {
    fake.healthy = false;
    const c = clock();
    const sleep = c.sleep;
    let calls = 0;
    const report = await runSmoke(
      options({
        clock: {
          now: c.now,
          sleep: async (ms) => {
            calls += 1;
            if (calls === 3) fake.healthy = true;
            await sleep(ms);
          },
        },
      }),
    );
    expect(report.steps).toHaveLength(7);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('2: the root is not the web app', async () => {
    fake.root = false;
    const f = await failure();
    expect(f.step).toBe(2);
    expect(f.message).toMatch(/^smoke step 2 \(web app\): /);
  });

  it('2: the page has no content security policy', async () => {
    fake.csp = false;
    const f = await failure();
    expect(f.step).toBe(2);
    expect(f.message).toMatch(/content-security-policy/);
  });

  it('3: the compose defaults do not sign in', async () => {
    fake.loginOk = false;
    const f = await failure();
    expect(f.step).toBe(3);
    expect(f.message).toMatch(/^smoke step 3 \(sign in\): /);
  });

  it('4: the import check lists something left out', async () => {
    fake.notes = [{ kind: 'ignored' }];
    const f = await failure();
    expect(f.step).toBe(4);
    expect(f.message).toMatch(/^smoke step 4 \(demo import\): /);
    expect(f.message).toMatch(/left out/);
  });

  it('4: the import itself is refused', async () => {
    fake.importStatus = 400;
    const f = await failure();
    expect(f.step).toBe(4);
    expect(f.message).toMatch(/400/);
  });

  it('5: generate flags a threat stale', async () => {
    fake.newlyStale = 1;
    const f = await failure();
    expect(f.step).toBe(5);
    expect(f.message).toMatch(/^smoke step 5 \(generate\): /);
    expect(f.message).toMatch(/stale/);
  });

  it('5: a threat of the model is already stale', async () => {
    fake.listedStale = true;
    const f = await failure();
    expect(f.step).toBe(5);
    expect(f.message).toMatch(/stale/);
  });

  it('6: the database port is reachable from the host', async () => {
    const f = await failure({ dbReachable: () => Promise.resolve(true) });
    expect(f.step).toBe(6);
    expect(f.message).toMatch(/^smoke step 6 \(database port\): /);
    expect(f.message).toMatch(/loopback|published/);
  });

  it('7: a label is missing, and one differs', async () => {
    const labels = { ...expectedLabels({ version: VERSION, sha: SHA }), 'org.opencontainers.image.version': '0.1.1' };
    delete (labels as Record<string, string>)['org.opencontainers.image.revision'];
    const f = await failure({ labels });
    expect(f.step).toBe(7);
    expect(f.message).toMatch(/^smoke step 7 \(image labels\): /);
    expect(f.message).toContain('org.opencontainers.image.version');
    expect(f.message).toContain('org.opencontainers.image.revision');
  });
});

describe('a threat the run would create is a notice, not a failure (FR-026)', () => {
  it('passes, reports the count and says it is a notice', async () => {
    fake.created = 2;
    const lines: string[] = [];
    const report = await runSmoke(options({ log: (line) => lines.push(line) }));
    expect(report.created).toBe(2);
    expect(lines.join('\n')).toMatch(/notice/i);
    expect(lines.join('\n')).toMatch(/2 threats? would be created/);
  });

  it('says nothing about it when there are none', async () => {
    const lines: string[] = [];
    await runSmoke(options({ log: (line) => lines.push(line) }));
    expect(lines.join('\n')).not.toMatch(/would be created/);
  });
});

describe('what a failure never says', () => {
  it('does not repeat the token or the password', async () => {
    fake.newlyStale = 1;
    const f = await failure({ password: 'admin' });
    expect(f.message).not.toContain('TOKEN-SECRET');
    expect(f.message).not.toMatch(/password/i);
  });
});
