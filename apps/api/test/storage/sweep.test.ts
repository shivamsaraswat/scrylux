import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import db, { kdb } from '../../src/db.js';
import { createStorage, newOriginalKey, type OriginalKey, type Storage } from '../../src/storage/index.js';
import { SWEEP_GRACE_MS, sweepStorage } from '../../src/storage/sweep.js';
import { startS3Stub } from './s3-stub.js';

// The sweep that removes what no source needs (Phase 3 Milestone 3, FR-055, SC-005, contracts/storage.md), on both backends.
// A key older than an hour that no source that is not ready points at is removed; a needed key, a young key and anything of
// another shape are left alone; and the line it logs holds counts.

const HOUR = 60 * 60 * 1000;
const OLD = new Date(Date.now() - 3 * HOUR);

interface Harness {
  storage: Storage;
  /** Stores bytes under a key as the storage would, then dates them. */
  plant: (key: string, modifiedAt: Date) => Promise<void>;
  holds: (key: string) => Promise<boolean>;
  close: () => Promise<void>;
  /** The medium itself, for the tests that need to put a stale temporary file there. */
  temporary?: (name: string, modifiedAt: Date) => Promise<void>;
  temporaryNames?: () => Promise<string[]>;
}

async function local(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'scrylux-sweep-'));
  const storage = createStorage({ backend: 'local', dir });
  const pathOf = (key: string): string => join(dir, key);
  return {
    storage,
    async plant(key, modifiedAt) {
      await mkdir(join(pathOf(key), '..'), { recursive: true });
      await writeFile(pathOf(key), 'x');
      await utimes(pathOf(key), modifiedAt, modifiedAt);
    },
    holds: (key) => readdir(join(pathOf(key), '..')).then((names) => names.includes(key.split('/').pop() as string), () => false),
    close: () => rm(dir, { recursive: true, force: true }),
    async temporary(name, modifiedAt) {
      await mkdir(join(dir, 'tmp'), { recursive: true });
      await writeFile(join(dir, 'tmp', name), 'half');
      await utimes(join(dir, 'tmp', name), modifiedAt, modifiedAt);
    },
    temporaryNames: () => readdir(join(dir, 'tmp')).catch(() => []),
  };
}

async function s3(): Promise<Harness> {
  const stub = await startS3Stub('document-bucket');
  const storage = createStorage({
    backend: 's3',
    bucket: 'document-bucket',
    prefix: 'scrylux/',
    region: 'us-east-1',
    endpoint: stub.endpoint,
    forcePathStyle: true,
    accessKeyId: 'AKIAFAKEACCESSKEY',
    secretAccessKey: 'fake-secret-access-key',
  });
  return {
    storage,
    plant: (key, modifiedAt) => {
      stub.seed(`scrylux/${key}`, 'x', modifiedAt);
      return Promise.resolve();
    },
    holds: (key) => Promise.resolve(stub.objects.has(`scrylux/${key}`)),
    close: () => stub.close(),
  };
}

const open: Harness[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((h) => h.close()));
});
beforeEach(async () => {
  await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
});
const make = async (build: () => Promise<Harness>): Promise<Harness> => {
  const harness = await build();
  open.push(harness);
  return harness;
};

let threatModel: string;
let account: number;
/** A source that is not ready and still has its original under this key, as a waiting, processing or failed one does. */
async function needing(key: OriginalKey): Promise<void> {
  if (threatModel === undefined) {
    account = (await db.query<{ id: number }>('INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id', [`u-${randomUUID()}`, 'x'])).rows[0]!.id;
    const project = (await db.query<{ id: string }>('INSERT INTO projects (name, created_by) VALUES ($1, $2) RETURNING id', [`p-${randomUUID()}`, account])).rows[0]!.id;
    threatModel = (await db.query<{ id: string }>('INSERT INTO threat_models (project_id, name) VALUES ($1, $2) RETURNING id', [project, 'model'])).rows[0]!.id;
  }
  await db.query(`INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, stored_bytes, original_key) VALUES ($1, 'a.md', 'md', 10, $2, $3, 10, $4)`, [threatModel, randomBytes(32), account, key]);
}

describe.each([
  ['the local volume', local],
  ['the S3-compatible service', s3],
] as const)('the sweep on %s', (_name, build) => {
  it('removes an old key that no source needs, and counts it', async () => {
    const h = await make(build);
    const orphan = newOriginalKey();
    await h.plant(orphan, OLD);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await sweepStorage(kdb, h.storage);
    expect(result).toMatchObject({ listed: 1, deleted: 1, failed: 0 });
    expect(await h.holds(orphan)).toBe(false);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ event: 'storage_sweep', listed: 1, deleted: 1, failed: 0 });
  });

  it('keeps the original of a source that is not ready, however old, so a retry can still read it', async () => {
    const h = await make(build);
    const needed = newOriginalKey();
    await h.plant(needed, OLD);
    await needing(needed);
    expect(await sweepStorage(kdb, h.storage)).toMatchObject({ listed: 1, deleted: 0, failed: 0 });
    expect(await h.holds(needed)).toBe(true);
  });

  it('keeps a key younger than an hour, which an upload may not yet have written its row for', async () => {
    const h = await make(build);
    const young = newOriginalKey();
    await h.plant(young, new Date(Date.now() - (SWEEP_GRACE_MS - 5 * 60 * 1000)));
    expect(await sweepStorage(kdb, h.storage)).toMatchObject({ listed: 1, deleted: 0 });
    expect(await h.holds(young)).toBe(true);
  });

  it('removes a key once it is older than the grace given', async () => {
    const h = await make(build);
    const k = newOriginalKey();
    await h.plant(k, new Date(Date.now() - 10_000));
    expect((await sweepStorage(kdb, h.storage, { graceMs: 5_000 })).deleted).toBe(1);
    expect(await h.holds(k)).toBe(false);
  });

  it('never touches anything outside the shape of an original', async () => {
    const h = await make(build);
    const odd = ['sources/design.md', `other/${randomUUID()}`, `sources/${randomUUID()}/extra`, `sources/${randomUUID().toUpperCase()}`];
    for (const key of odd) await h.plant(key, OLD);
    expect(await sweepStorage(kdb, h.storage)).toMatchObject({ listed: 0, deleted: 0, failed: 0 });
    for (const key of odd) expect(await h.holds(key), key).toBe(true);
  });

  it('keeps going when one removal fails, counts it, and tries it again next time', async () => {
    const h = await make(build);
    const [a, b] = [newOriginalKey(), newOriginalKey()];
    await h.plant(a, OLD);
    await h.plant(b, OLD);
    const real = h.storage.delete.bind(h.storage);
    let first = true;
    vi.spyOn(h.storage, 'delete').mockImplementation(async (k) => {
      if (first) {
        first = false;
        throw new Error('down');
      }
      return real(k);
    });
    expect(await sweepStorage(kdb, h.storage)).toMatchObject({ listed: 2, deleted: 1, failed: 1 });
    vi.restoreAllMocks();
    expect(await sweepStorage(kdb, h.storage)).toMatchObject({ listed: 1, deleted: 1, failed: 0 });
    expect(await h.holds(a)).toBe(false);
    expect(await h.holds(b)).toBe(false);
  });

  it('does not throw when storage cannot be listed, and counts a failure', async () => {
    const h = await make(build);
    vi.spyOn(h.storage, 'list').mockImplementation(() => {
      throw new Error('down');
    });
    expect(await sweepStorage(kdb, h.storage)).toMatchObject({ failed: 1, deleted: 0 });
  });

  it('is safe when two run at once', async () => {
    const h = await make(build);
    const keys = Array.from({ length: 8 }, () => newOriginalKey());
    for (const k of keys) await h.plant(k, OLD);
    const keep = newOriginalKey();
    await h.plant(keep, OLD);
    await needing(keep);
    const [one, two] = await Promise.all([sweepStorage(kdb, h.storage), sweepStorage(kdb, h.storage)]);
    expect(one.failed + two.failed).toBe(0);
    for (const k of keys) expect(await h.holds(k)).toBe(false);
    expect(await h.holds(keep)).toBe(true);
  });

  it('logs one line with counts only, and no key', async () => {
    const h = await make(build);
    const k = newOriginalKey();
    await h.plant(k, OLD);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await sweepStorage(kdb, h.storage);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(['deleted', 'event', 'failed', 'listed', 'temporary']);
    expect(line).not.toContain(k);
  });
});

describe('the sweep on the local volume: half-written files', () => {
  it('removes a stale temporary file and keeps a recent one', async () => {
    const h = await make(local);
    await h.temporary!('stale', OLD);
    await h.temporary!('recent', new Date());
    const result = await sweepStorage(kdb, h.storage);
    expect(result.temporary).toBe(1);
    expect(await h.temporaryNames!()).toEqual(['recent']);
  });
});
