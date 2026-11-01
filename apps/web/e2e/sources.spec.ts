import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiToken, expect, seedModel, signInAsNewAccount, test } from './fixtures.js';

// Adding a document, end to end in the built app (Phase 3 Milestone 3, US1, US2, US3, US4; SC-001, SC-009): the notice that text
// leaves the install is on screen before the submit control; a Markdown file becomes ready without a reload; its chunks can be read;
// and deleting it removes it and its stored original. It starts its own app, worker and stand-in embedding provider on ports of
// their own, sharing a temporary storage directory, so that every other spec still runs with no provider and no worker (SC-001). The
// provider is declared hosted (an https address), so the notice has something to say; the worker trusts the stand-in's own
// certificate and nothing else.

const APP_PORT = 3103;
const HEALTH_PORT = 3104;
const APP = `http://localhost:${APP_PORT}`;
const API_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'dist');

test.use({ baseURL: APP });
test.describe.configure({ mode: 'serial' });

let provider: Server;
let app: ChildProcess | undefined;
let worker: ChildProcess | undefined;
let work: string;
let storageDir: string;

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
  work = mkdtempSync(path.join(tmpdir(), 'scrylux-e2e-sources-'));
  storageDir = path.join(work, 'storage');

  // A certificate for the stand-in provider, made for this run and trusted only by the worker started below.
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(work, 'key.pem'), '-out', path.join(work, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
    { stdio: 'ignore' },
  );

  // The stand-in embedding provider: one vector of three numbers for every input, and nothing else is served.
  provider = createServer({ key: readFileSync(path.join(work, 'key.pem')), cert: readFileSync(path.join(work, 'cert.pem')) }, (req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/embeddings') === true) {
        const { input } = JSON.parse(Buffer.concat(parts).toString('utf8')) as { input: string | string[] };
        const inputs = Array.isArray(input) ? input : [input];
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"not served"}}');
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (address === null || typeof address === 'string') throw new Error('the stand-in provider has no port');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(APP_PORT),
    EMBEDDING_PROVIDER: 'openai-compatible',
    EMBEDDING_MODEL: 'stub-embed',
    EMBEDDING_BASE_URL: `https://localhost:${address.port}/v1`,
    EMBEDDING_API_KEY: 'e2e-stand-in-key',
    NODE_EXTRA_CA_CERTS: path.join(work, 'cert.pem'),
    STORAGE_BACKEND: 'local',
    STORAGE_DIR: storageDir,
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

const originals = (): string[] => {
  try {
    return readdirSync(path.join(storageDir, 'sources'));
  } catch {
    return [];
  }
};

test('tells the person where the text goes, adds a document, reads its chunks and deletes it', async ({ page }) => {
  await signInAsNewAccount(page, APP);
  const { modelId } = await seedModel(APP, await apiToken(APP), 'sources');

  await page.goto(`/threat-models/${modelId}/sources`);
  await expect(page.getByRole('heading', { name: 'Documents', level: 2 })).toBeVisible();
  await expect(page.getByText('No documents yet.')).toBeVisible();

  // The notice is part of the form and comes before the control that submits it (SC-009).
  const upload = page.getByRole('button', { name: 'Upload' });
  const form = upload.locator('xpath=ancestor::form');
  const notice = form.getByRole('note');
  await expect(notice).toContainText('Text you add here is sent to an OpenAI-compatible service outside this install, to make its embeddings.');
  const noticeBox = await notice.boundingBox();
  const buttonBox = await upload.boundingBox();
  expect(noticeBox).not.toBeNull();
  expect(buttonBox).not.toBeNull();
  expect(noticeBox!.y).toBeLessThan(buttonBox!.y);

  // A Markdown file becomes ready without a reload.
  const text = '# Gateway\n\nThe gateway forwards each request to the payment service and stores the record.\n';
  await page.getByLabel(/Files/).setInputFiles({ name: 'design.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await upload.click();
  await expect(page.getByText('design.md: added')).toBeVisible();
  const row = page.getByRole('row').filter({ has: page.getByText('design.md', { exact: true }) });
  await expect(row.getByText(/^Ready: 1 chunk/)).toBeVisible({ timeout: 30_000 });
  // The original is gone as soon as the document is ready (FR-057).
  expect(originals()).toEqual([]);

  // What was read: the chunk, as text, with where it came from.
  await row.getByRole('link', { name: 'design.md' }).click();
  await expect(page.getByRole('heading', { name: 'design.md', level: 1 })).toBeVisible();
  const chunk = page.getByRole('listitem', { name: 'Chunk 1' });
  await expect(chunk).toContainText('The gateway forwards each request to the payment service');
  await expect(chunk).toContainText('Gateway');
  await expect(chunk).toContainText('Lines 1–3');

  // Deleting asks first, then the document is gone.
  await page.getByRole('link', { name: 'All documents' }).click();
  await page.getByRole('button', { name: 'Delete design.md' }).click();
  await expect(page.getByText('Delete design.md? Its text and chunks are removed.')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No documents yet.')).toBeVisible();
  await expect(page.getByText('design.md')).toHaveCount(0);
});
