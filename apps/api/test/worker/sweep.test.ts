import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kdb } from '../../src/db.js';
import { createStorage, newOriginalKey, type Storage } from '../../src/storage/index.js';
import { startWorker, type Worker } from '../../src/worker/loop.js';
import { FAST, clientFor, localConfig, sleep, waitFor } from './helpers.js';

// The worker runs the storage sweep when it starts and then at an interval (Phase 3 Milestone 3, FR-055, T061).

let dir: string;
let worker: Worker | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scrylux-worker-sweep-'));
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function plantOld(): Promise<string> {
  const key = newOriginalKey();
  await mkdir(join(dir, 'sources'), { recursive: true });
  const path = join(dir, key);
  await writeFile(path, 'x');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(path, old, old);
  return path;
}
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);
const gone = (path: string): Promise<true> => waitFor(async () => ((await exists(path)) ? undefined : true), 5000, 'the original to be swept');
async function start(storage: Storage, sweepMs: number): Promise<Worker> {
  const config = localConfig('http://127.0.0.1:9');
  return startWorker({ db: kdb, llm: clientFor(config), llmConfig: config, timings: { ...FAST, sweepMs }, storage });
}

describe('the worker sweeps storage', () => {
  it('at start', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const orphan = await plantOld();
    worker = await start(createStorage({ backend: 'local', dir }), 3_600_000);
    await gone(orphan);
  });

  it('again every sweepMs', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    worker = await start(createStorage({ backend: 'local', dir }), 50);
    await sleep(100);
    const later = await plantOld();
    await gone(later);
  });

  it('and a sweep that fails does not stop the worker from starting', async () => {
    const broken = createStorage({ backend: 'local', dir });
    vi.spyOn(broken, 'list').mockImplementation(() => {
      throw new Error('down');
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    worker = await start(broken, 50);
    await sleep(150);
    expect(worker.id).toBeTruthy();
  });
});
