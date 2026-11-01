import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { kdb } from '../../src/db.js';
import { startHealthServer, type HealthServer } from '../../src/worker/health.js';
import { startWorker } from '../../src/worker/loop.js';
import { FAST, clientFor, localConfig, resetJobTables } from './helpers.js';

// The worker's health check (Phase 3 Milestone 2, FR-010, research #10, Principle IV): 200 while the process is up, no
// authentication, no database, no provider.

const servers: HealthServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(): Promise<{ url: string; server: HealthServer }> {
  const server = await startHealthServer(0);
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, server };
}

describe('GET /health', () => {
  it('answers 200 {"status":"ok"} from the moment the server is listening, with no credentials', async () => {
    const { url } = await start();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it.each([
    ['another path', 'GET', '/'],
    ['another path', 'GET', '/health/extra'],
    ['another path', 'GET', '/api/v1/jobs'],
    ['another method', 'POST', '/health'],
    ['another method', 'DELETE', '/health'],
  ])('answers 404 for %s: %s %s', async (_label, method, path) => {
    const { url } = await start();
    const res = await fetch(`${url}${path}`, { method });
    expect(res.status).toBe(404);
  });

  it('serves nothing else: no job, no worker, no setting', async () => {
    const { url } = await start();
    const body = await (await fetch(`${url}/health`)).text();
    expect(body).toBe('{"status":"ok"}');
  });

  it('does not need the database: it does not import it, and answers with the database unreachable', async () => {
    const source = readFileSync(new URL('../../src/worker/health.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '\.\.?\/(\.\.\/)?db\.js'|@scrylux\/db|@scrylux\/llm|kysely|'pg'/);
    const previous = process.env.DB_PORT;
    process.env.DB_PORT = '1';
    try {
      const { url } = await start();
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.DB_PORT;
      else process.env.DB_PORT = previous;
    }
  });

  it('still answers 200 while the worker is stopping, until the process is done (Principle IV)', async () => {
    await resetJobTables();
    const stub = createServer((_req, res) => void res.end());
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const address = stub.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const config = localConfig(`http://127.0.0.1:${address.port}`, { embeddings: false });
    const worker = await startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: FAST });
    const { url } = await start();

    const stopping = worker.stop();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await stopping;
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await new Promise((resolve) => stub.close(resolve));
  });

  it('stops listening when closed', async () => {
    const { url, server } = await start();
    await server.close();
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });
});
