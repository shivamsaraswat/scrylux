import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { expect, signInAsNewAccount, test } from './fixtures.js';

// The provider check, end to end in the built app (Phase 3 Milestone 2, US1, US3, US6; SC-002): a person starts it on the
// Jobs page, a worker runs it against a provider, and the page follows the job to its end without a reload. It starts its own
// app, worker and stand-in provider on ports of their own, so that every other spec still runs with no provider configured
// and no worker (SC-001). The app and the worker are the built ones, started the way the image starts them.

const APP_PORT = 3101;
const HEALTH_PORT = 3102;
const APP = `http://localhost:${APP_PORT}`;
const API_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'dist');

test.use({ baseURL: APP });
test.describe.configure({ mode: 'serial' });

let provider: Server;
let app: ChildProcess | undefined;
let worker: ChildProcess | undefined;

/** Starts a provider check and returns its row: the first, once the list has grown by one (the list is shared and newest first). */
async function startCheck(page: Page): Promise<Locator> {
  await expect(page.locator('table').or(page.getByText('No jobs yet.'))).toBeVisible();
  const links = page.getByRole('link', { name: 'Provider check' });
  const before = await links.count();
  await page.getByRole('button', { name: 'Check AI provider' }).click();
  await expect(links).toHaveCount(before + 1);
  return page.getByRole('row').filter({ has: links }).first();
}

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

function startWorker(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn('node', [path.join(API_DIST, 'worker.js')], { env, stdio: 'ignore' });
}

let env: NodeJS.ProcessEnv;

test.beforeAll(async () => {
  // A stand-in for the model provider: every chat completion is the check's answer, and nothing else is served.
  provider = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions') === true) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-e2e',
            object: 'chat.completion',
            created: 0,
            model: 'stub-model',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"status":"ok"}', refusal: null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 64, completion_tokens: 9, total_tokens: 73 },
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

  env = {
    ...process.env,
    PORT: String(APP_PORT),
    LLM_PROVIDER: 'openai-compatible',
    LLM_MODEL: 'stub-model',
    LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    LLM_LOCAL: 'true',
    PROVIDER_CHECK_COOLDOWN: '0',
    JOBS_PER_ACCOUNT: '100',
    WORKER_HEALTH_PORT: String(HEALTH_PORT),
  };
  app = spawn('node', [path.join(API_DIST, 'server.js')], { env, stdio: 'ignore' });
  await waitForOk(`${APP}/health`, 'the app');
  worker = startWorker(env);
  await waitForOk(`http://127.0.0.1:${HEALTH_PORT}/health`, 'the worker');
});

test.afterAll(async () => {
  await stop(worker);
  await stop(app);
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

test('checks the AI provider from the Jobs page and follows the job to its end without a reload', async ({ page }) => {
  await signInAsNewAccount(page, APP);

  await page.getByRole('link', { name: 'Jobs' }).click();
  await expect(page.getByRole('heading', { name: 'Jobs', level: 1 })).toBeVisible();
  await expect(page.getByText('Generation: openai-compatible, model stub-model, local: data sent to it stays in this install')).toBeVisible();
  await expect(page.getByText('Embeddings: not configured')).toBeVisible();

  // Starting the check queues it at once; the worker takes it and the row follows it, with no reload in between. The list
  // is newest first and shared by every account, so the job just started is the first row.
  const row = await startCheck(page);
  await expect(row.getByText('Succeeded')).toBeVisible({ timeout: 10_000 });
  await expect(row.getByText('64 in, 9 out')).toBeVisible();
  await expect(row.getByText('cost unknown')).toBeVisible();
  await expect(page.getByText(/No worker is processing jobs/)).toHaveCount(0);

  // The job: where its data went, that it worked, and what it used.
  await row.getByRole('link', { name: 'Provider check' }).click();
  await expect(page.getByRole('heading', { name: 'Provider check', level: 1 })).toBeVisible();
  await expect(page.getByText('Succeeded')).toBeVisible();
  const generation = page.getByRole('region', { name: 'Generation' });
  await expect(generation.getByText('Worked')).toBeVisible();
  await expect(generation.getByText('Local: data sent to it stays in this install')).toBeVisible();
  await expect(generation.getByText('64 in, 9 out, cost unknown')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Embeddings' }).getByText('Not configured')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job' })).toHaveCount(0);

  // The job has its own address, which survives a reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Provider check', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Generation' }).getByText('Worked')).toBeVisible();
});

test('says when no worker is running, and cancels a job that is still queued', async ({ page }) => {
  await signInAsNewAccount(page, APP);
  // A worker that stops cleanly takes its row with it, so the page can say so at once.
  await stop(worker);

  await page.goto('/jobs');
  const row = await startCheck(page);
  await expect(row.getByText('Queued')).toBeVisible();
  await expect(page.getByText(/No worker is processing jobs/)).toBeVisible({ timeout: 10_000 });

  await row.getByRole('link', { name: 'Provider check' }).click();
  await page.getByRole('button', { name: 'Cancel job' }).click();
  // Asked first, and nothing is sent until the question is answered.
  await expect(page.getByText(/stops as soon as it can/i)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel the job' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByText('Cancelled by')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job' })).toHaveCount(0);

  // A worker started afterwards never runs it.
  worker = startWorker(env);
  await waitForOk(`http://127.0.0.1:${HEALTH_PORT}/health`, 'the worker');
  await page.goto('/jobs');
  await expect(page.getByRole('row').filter({ has: page.getByRole('link', { name: 'Provider check' }) }).first().getByText('Cancelled')).toBeVisible();
  await expect(page.getByText(/No worker is processing jobs/)).toHaveCount(0, { timeout: 10_000 });
});
