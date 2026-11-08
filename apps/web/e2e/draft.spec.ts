import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiToken, expect, seedModel, signInAsNewAccount, test } from './fixtures.js';

// Proposing a system from documents, end to end in the built app (Phase 3 Milestone 4, SC-010): a document is added and becomes
// ready; the notice that text leaves the install is on screen before the control that starts the extraction; the draft appears as a
// diagram and a list; an item can be selected, its citation opened in its source at the right chunk; and the draft can be discarded.
// It starts its own app, worker and stand-in provider on ports of their own, so that every other spec still runs with no provider
// and no worker. The provider is declared hosted (an https address), so the notice has something to say; the worker trusts the
// stand-in's own certificate and nothing else.

const APP_PORT = 3105;
const HEALTH_PORT = 3106;
const APP = `http://localhost:${APP_PORT}`;
const API_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'dist');

test.use({ baseURL: APP });
test.describe.configure({ mode: 'serial' });

const DOCUMENT =
  '# Gateway\n\n' +
  'The API stores threats in a PostgreSQL database.\n' +
  'The database runs in a private network and is reachable only from the API.\n';

// The one answer the stand-in gives, whatever it is asked: every quote is a passage of DOCUMENT, which is a single chunk, c1.
const cite = (quote: string) => ({ chunk: 'c1', quote });
const ANSWER = {
  elements: [
    {
      ref: 'private_net',
      type: 'trust_boundary',
      name: 'Private network',
      boundary: null,
      source: null,
      target: null,
      flags: [],
      rationale: 'The database runs in a private network.',
      citations: [cite('runs in a private network')],
    },
    {
      ref: 'api',
      type: 'process',
      name: 'API',
      boundary: null,
      source: null,
      target: null,
      flags: [],
      rationale: 'The API stores the threats.',
      citations: [cite('The API stores threats')],
    },
    {
      ref: 'db',
      type: 'data_store',
      name: 'Database',
      boundary: 'private_net',
      source: null,
      target: null,
      flags: [],
      rationale: 'Threats are kept in a PostgreSQL database.',
      citations: [cite('stores threats in a PostgreSQL database')],
    },
    {
      ref: 'api_db',
      type: 'data_flow',
      name: 'Threat data',
      boundary: null,
      source: 'api',
      target: 'db',
      flags: [],
      rationale: 'The API reads and writes threats in the database.',
      citations: [cite('The API stores threats')],
    },
  ],
  assets: [],
  assumptions: [
    {
      ref: 'private_db',
      statement: 'The database is reachable only from the API.',
      rationale: 'The design relies on the network keeping everyone else out.',
      citations: [cite('reachable only from the API')],
    },
  ],
  nothing_found: null,
};

let provider: Server;
let app: ChildProcess | undefined;
let worker: ChildProcess | undefined;
let work: string;

async function waitForOk(url: string, what: string): Promise<void> {
  const until = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > until) throw new Error(`${what} did not become healthy`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function stop(child: ChildProcess | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (child === undefined || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
  });
}

test.beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'scrylux-e2e-draft-'));

  // A certificate for the stand-in provider, made for this run and trusted only by the worker started below.
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(work, 'key.pem'), '-out', path.join(work, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    { stdio: 'ignore' },
  );

  // The stand-in provider: one vector of three numbers for every input to embed, and the one answer to every request to generate.
  provider = createServer({ key: readFileSync(path.join(work, 'key.pem')), cert: readFileSync(path.join(work, 'cert.pem')) }, (req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url?.endsWith('/embeddings') === true) {
        const { input } = JSON.parse(Buffer.concat(parts).toString('utf8')) as { input: string | string[] };
        const inputs = Array.isArray(input) ? input : [input];
        res.writeHead(200);
        res.end(
          JSON.stringify({
            object: 'list',
            model: 'stub-embed',
            data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })),
            usage: { prompt_tokens: inputs.length * 4, total_tokens: inputs.length * 4 },
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions') === true) {
        res.writeHead(200);
        res.end(
          JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion',
            created: 0,
            model: 'stub-chat',
            choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(ANSWER), refusal: null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 400, completion_tokens: 300, total_tokens: 700 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end('{"error":{"message":"not served"}}');
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('the stand-in provider has no port');
  const base = `https://localhost:${address.port}/v1`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(APP_PORT),
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'stub-chat',
    LLM_BASE_URL: base,
    LLM_API_KEY: 'e2e-stand-in-key',
    LLM_PRICE_INPUT: '1',
    LLM_PRICE_OUTPUT: '1',
    EMBEDDING_PROVIDER: 'openai-compatible',
    EMBEDDING_MODEL: 'stub-embed',
    EMBEDDING_BASE_URL: base,
    EMBEDDING_API_KEY: 'e2e-stand-in-key',
    NODE_EXTRA_CA_CERTS: path.join(work, 'cert.pem'),
    STORAGE_BACKEND: 'local',
    STORAGE_DIR: path.join(work, 'storage'),
    JOBS_PER_ACCOUNT: '100',
    WORKER_HEALTH_PORT: String(HEALTH_PORT),
  };
  app = spawn('node', [path.join(API_DIST, 'server.js')], { env, stdio: 'ignore' });
  await waitForOk(`${APP}/health`, 'the app');
  worker = spawn('node', [path.join(API_DIST, 'worker.js')], { env, stdio: 'ignore' });
  await waitForOk(`http://127.0.0.1:${HEALTH_PORT}/health`, 'the worker');
});

test.afterAll(async () => {
  await stop(worker);
  await stop(app);
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
});

test('proposes a system from a document, shows it with its citations, and discards it', async ({ page }) => {
  await signInAsNewAccount(page, APP);
  const { modelId } = await seedModel(APP, await apiToken(APP), 'draft');

  // A document is added and becomes ready.
  await page.goto(`/threat-models/${modelId}/sources`);
  await page.getByLabel(/Files/).setInputFiles({ name: 'design.md', mimeType: 'text/markdown', buffer: Buffer.from(DOCUMENT) });
  await page.getByRole('button', { name: 'Upload' }).click();
  const row = page.getByRole('row').filter({ has: page.getByText('design.md', { exact: true }) });
  await expect(row.getByText(/^Ready: 1 chunk/)).toBeVisible({ timeout: 30_000 });

  // The notice that the text leaves the install comes before the control that starts the extraction (SC-010).
  await page.getByRole('link', { name: 'Draft', exact: true }).click();
  const start = page.getByRole('button', { name: 'Start extraction' });
  await expect(start).toBeVisible();
  const notice = page.getByRole('note', { name: 'Where the text of your sources goes' });
  await expect(notice).toContainText('outside this install');
  const noticeBox = await notice.boundingBox();
  const buttonBox = await start.boundingBox();
  expect(noticeBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(noticeBox!.y).toBeLessThan(buttonBox!.y);
  await expect(page.getByRole('region', { name: 'Draft items' })).toHaveCount(0);

  // The draft appears without a reload, marked as not part of the threat model.
  await start.click();
  const banner = page.getByRole('note', { name: 'Draft status' });
  await expect(banner).toContainText('Draft proposed by AI. It is not part of this threat model.', { timeout: 60_000 });

  // The list holds every item under its kind, and the diagram draws the nodes.
  const list = page.getByRole('region', { name: 'Draft items' });
  await expect(list.getByRole('button', { name: 'API', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Database', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: /The database is reachable only from the API\./ })).toBeVisible();

  // Selecting an item shows why it was proposed and the passage it was taken from.
  await list.getByRole('button', { name: 'Database', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Selected item' });
  await expect(panel).toContainText('Threats are kept in a PostgreSQL database.');
  await expect(panel).toContainText('stores threats in a PostgreSQL database');

  // The citation opens its source at the chunk it quotes.
  await panel.getByRole('link', { name: 'Open in source' }).first().click();
  await expect(page.getByRole('heading', { name: 'design.md', level: 1 })).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Chunk 1' })).toContainText('The API stores threats in a PostgreSQL database.');

  // Discarding asks first, then the draft is gone and the threat model's own diagram was never touched.
  await page.goto(`/threat-models/${modelId}/draft`);
  await page.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('region', { name: 'Draft items' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start extraction' })).toBeVisible();
});
