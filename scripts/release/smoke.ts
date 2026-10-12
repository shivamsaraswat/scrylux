import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLabels, expectedLabels } from './versions.js';

// The smoke run of the release pipeline (contracts/release-pipeline.md "What `smoke` checks"; spec FR-004, FR-009, FR-017).
// It talks to a running Specter over HTTP, as a user's script would, and uses no code of the application. It fails on the
// FIRST step that does not hold, with a message that names the step and never repeats a credential.

export const STEP_NAMES = ['health', 'web app', 'sign in', 'demo import', 'generate', 'database port', 'image labels'] as const;

export class SmokeFailure extends Error {
  constructor(
    readonly step: number,
    detail: string,
  ) {
    super(`smoke step ${step} (${STEP_NAMES[step - 1] ?? '?'}): ${detail}`);
    this.name = 'SmokeFailure';
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface SmokeOptions {
  baseUrl: string;
  // The parsed demo file, sent as the body of the import.
  demo: unknown;
  version: string;
  sha: string;
  // The labels the running image carries (`docker image inspect`).
  labels: Record<string, string>;
  username?: string;
  password?: string;
  clock?: Clock;
  // Whether the database answers on the host (it must not).
  dbReachable?: () => Promise<boolean>;
  log?: (line: string) => void;
}

export interface SmokeReport {
  steps: { n: number; name: string; detail: string }[];
  // How many threats the current rules would add to the demo. A notice, never a failure (spec FR-026).
  created: number;
}

const HEALTH_SECONDS = 60;
const real: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

async function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 5432 });
    const done = (answer: boolean): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const { baseUrl, demo, version, sha, labels } = options;
  const clock = options.clock ?? real;
  const dbReachable = options.dbReachable ?? reachable;
  const log = options.log ?? ((line: string) => console.log(line));
  const username = options.username ?? 'admin';
  const password = options.password ?? 'admin';
  const steps: SmokeReport['steps'] = [];
  const pass = (n: number, detail: string): void => {
    steps.push({ n, name: STEP_NAMES[n - 1] ?? '?', detail });
    log(`ok   step ${n} (${STEP_NAMES[n - 1] ?? '?'}): ${detail}`);
  };
  // A network error is a failure of the step it happened in, not a crash of the script.
  const call = async (n: number, what: string, input: string, init?: RequestInit): Promise<Response> => {
    try {
      return await fetch(`${baseUrl}${input}`, init);
    } catch (error) {
      throw new SmokeFailure(n, `${what} could not be reached (${error instanceof Error ? error.message : 'network error'})`);
    }
  };

  // 1. health
  const started = clock.now();
  for (;;) {
    let status: number;
    try {
      status = (await fetch(`${baseUrl}/health`)).status;
    } catch {
      status = 0;
    }
    if (status === 200) break;
    if (clock.now() - started >= HEALTH_SECONDS * 1000) throw new SmokeFailure(1, `GET /health did not answer 200 within ${HEALTH_SECONDS} seconds (last answer: ${status === 0 ? 'none' : status})`);
    await clock.sleep(2000);
  }
  pass(1, 'GET /health answered 200');

  // 2. the web app, under its content security policy
  const page = await call(2, 'GET /', '/');
  const html = await page.text();
  if (page.status !== 200 || !/<div id="root"/.test(html)) throw new SmokeFailure(2, `GET / did not answer the web app (status ${page.status}, no <div id="root">)`);
  if ((page.headers.get('content-security-policy') ?? '') === '') throw new SmokeFailure(2, 'GET / has no content-security-policy header');
  pass(2, 'GET / serves the web app with a content-security-policy header');

  // 3. sign in with the compose defaults
  const login = await call(3, 'POST /api/login', '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const token = login.status === 200 ? ((await login.json().catch(() => ({}))) as { token?: string }).token : undefined;
  if (token === undefined || token === '') throw new SmokeFailure(3, `the compose defaults did not sign in (POST /api/login answered ${login.status})`);
  pass(3, 'the compose defaults signed in');
  const authed = (extra: Record<string, string> = {}): RequestInit['headers'] => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra });

  // 4. the demo, imported with nothing left out
  const project = await call(4, 'POST /api/v1/projects', '/api/v1/projects', {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ name: `Smoke ${randomUUID()}` }),
  });
  const projectId = project.status === 201 ? ((await project.json()) as { id: string }).id : undefined;
  if (projectId === undefined) throw new SmokeFailure(4, `could not create a project to import into (POST /api/v1/projects answered ${project.status})`);
  const body = JSON.stringify({ format: 'specter', file: demo });
  const check = await call(4, 'the import check', `/api/v1/projects/${projectId}/imports/check`, { method: 'POST', headers: authed(), body });
  if (check.status !== 200) throw new SmokeFailure(4, `the import check refused the demo (answered ${check.status})`);
  const summary = (await check.json()) as { models: { name_issue: string | null; elements: number }[]; notes: unknown[] };
  if (summary.notes.length > 0) throw new SmokeFailure(4, `the import check lists ${summary.notes.length} thing(s) left out of the demo`);
  if (summary.models.length !== 1 || summary.models[0]?.name_issue !== null) throw new SmokeFailure(4, 'the import check does not describe exactly one importable threat model');
  const imported = await call(4, 'the import', `/api/v1/projects/${projectId}/imports`, { method: 'POST', headers: authed(), body });
  const modelId = imported.status === 201 ? ((await imported.json()) as { threat_models: { id: string }[] }).threat_models[0]?.id : undefined;
  if (modelId === undefined) throw new SmokeFailure(4, `the import was refused (answered ${imported.status})`);
  pass(4, 'the demo imported with nothing left out');

  // 5. generate: no stale threat; a threat that would be created is a notice
  const generated = await call(5, 'generate', `/api/v1/threat-models/${modelId}/threats/generate`, { method: 'POST', headers: authed(), body: '{}' });
  if (generated.status !== 200) throw new SmokeFailure(5, `"Generate threats" answered ${generated.status}`);
  const counts = (await generated.json()) as { created: number; newly_stale: number };
  if (counts.newly_stale > 0) throw new SmokeFailure(5, `"Generate threats" flagged ${counts.newly_stale} threat(s) of the demo stale: a rule changed or was retired under it`);
  const listed = await call(5, 'the threat list', `/api/v1/threat-models/${modelId}/threats`, { headers: authed() });
  const stale = ((await listed.json()) as { stale: unknown }[]).filter((t) => t.stale !== null && t.stale !== undefined).length;
  if (stale > 0) throw new SmokeFailure(5, `${stale} threat(s) of the demo are stale`);
  pass(5, 'no threat of the demo is stale');
  if (counts.created > 0) {
    log(`notice: ${counts.created} threat${counts.created === 1 ? '' : 's'} would be created by the current rules; a rule was added after the demo was committed, and the demo is brought up to date in a later change (not a failure)`);
  }

  // 6. only the app is published
  if (await dbReachable()) throw new SmokeFailure(6, 'the database answers on 127.0.0.1:5432 from the host; the release compose file must publish only the app, on the loopback address');
  pass(6, 'the database is not reachable from the host');

  // 7. the labels of FR-009
  const problems = checkLabels(labels, expectedLabels({ version, sha }));
  if (problems.length > 0) throw new SmokeFailure(7, `the image's labels are wrong: ${problems.join('; ')}`);
  pass(7, 'the image carries the six labels of the contract');

  return { steps, created: counts.created };
}

function main(argv: string[]): Promise<number> {
  const [baseUrl, demoFile, version, sha, imageRef] = argv;
  if ([baseUrl, demoFile, version, sha, imageRef].some((a) => a === undefined)) {
    console.error('usage: tsx scripts/release/smoke.ts <base-url> <demo-file> <version> <commit> <image-ref>');
    return Promise.resolve(2);
  }
  return (async () => {
    try {
      const inspected = execFileSync('docker', ['image', 'inspect', imageRef as string, '--format', '{{json .Config.Labels}}'], { encoding: 'utf8' });
      const labels = (JSON.parse(inspected) as Record<string, string> | null) ?? {};
      const demo: unknown = JSON.parse(readFileSync(path.resolve(demoFile as string), 'utf8'));
      const report = await runSmoke({
        baseUrl: baseUrl as string,
        demo,
        version: version as string,
        sha: sha as string,
        labels,
        username: process.env.SMOKE_ADMIN_USERNAME,
        password: process.env.SMOKE_ADMIN_PASSWORD,
      });
      console.log(`smoke run passed: ${report.steps.length} steps`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  })();
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
