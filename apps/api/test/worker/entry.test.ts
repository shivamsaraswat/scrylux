import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { getJob } from '../../src/jobs/store.js';
import { SETTINGS, makeUser, queueCheck, resetJobTables } from './helpers.js';

// The order of the worker's start (contracts/worker.md, "Start, in order"): the health server is listening before the loop
// registers the worker or claims a job, so a health port that is taken stops the process while it holds nothing.

const API_DIR = fileURLToPath(new URL('../..', import.meta.url));

beforeEach(resetJobTables);
afterEach(resetJobTables);

describe('the worker process', () => {
  it('exits before it registers or claims anything when its health port is taken', async () => {
    // On every address, as the health server listens, so that the port is really taken.
    const taken = createServer((_req, res) => res.end());
    await new Promise<void>((resolve) => taken.listen(0, resolve));
    const address = taken.address();
    if (address === null || typeof address === 'string') throw new Error('the stand-in server has no port');
    try {
      const alice = await makeUser();
      const id = await queueCheck(alice, SETTINGS);

      const env: NodeJS.ProcessEnv = { ...process.env, WORKER_HEALTH_PORT: String(address.port), PROVIDER_CHECK_COOLDOWN: '0' };
      for (const name of Object.keys(env)) if (/^(LLM|EMBEDDING)_/.test(name) && name !== 'LLM_TIMEOUT') delete env[name];
      const child = spawn(path.join(API_DIR, '..', '..', 'node_modules', '.bin', 'tsx'), ['--conditions=@scrylux/source', 'src/worker.ts'], { cwd: API_DIR, env, stdio: 'ignore' });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });

      expect(code).toBe(1);
      expect((await db.query('SELECT 1 FROM workers')).rowCount).toBe(0);
      expect(await getJob(kdb, id)).toMatchObject({ state: 'queued', run: 0 });
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  }, 30_000);
});
