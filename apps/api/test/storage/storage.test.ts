import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageUnavailable, createStorage, newOriginalKey, parseOriginalKey, type OriginalKey, type Storage } from '../../src/storage/index.js';
import { startS3Stub, type S3Stub } from './s3-stub.js';

// The storage abstraction and its two backends (Phase 3 Milestone 3, FR-050, contracts/storage.md). One suite runs against
// both, so a backend cannot differ from the other in a way the rest of Scrylux would notice.

interface Harness {
  storage: Storage;
  /** Puts something in storage without going through the backend: a key of any shape, however old. */
  plant: (relativeKey: string, content?: string, modifiedAt?: Date) => Promise<void>;
  /** Whether storage holds this key, asked of the medium itself. */
  holds: (relativeKey: string) => Promise<boolean>;
  /** Makes storage unavailable. */
  breakIt: () => Promise<void>;
  /** What an error from storage must never repeat: a path, a bucket, an address, a credential. */
  secrets: string[];
  close: () => Promise<void>;
}

const OLD = new Date('2020-01-01T00:00:00Z');
const collect = async (storage: Storage): Promise<{ key: OriginalKey; modifiedAt: Date }[]> => {
  const found: { key: OriginalKey; modifiedAt: Date }[] = [];
  for await (const item of storage.list()) found.push(item);
  return found;
};
const key = (): OriginalKey => newOriginalKey();

async function localHarness(): Promise<Harness & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'scrylux-storage-test-'));
  const root = join(dir, 'originals');
  return {
    dir: root,
    storage: createStorage({ backend: 'local', dir: root }),
    async plant(relativeKey, content = 'x', modifiedAt) {
      const path = join(root, relativeKey);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, content);
      if (modifiedAt) await utimes(path, modifiedAt, modifiedAt);
    },
    holds: (relativeKey) => access(join(root, relativeKey)).then(() => true, () => false),
    async breakIt() {
      await rm(root, { recursive: true, force: true });
      await writeFile(root, 'a file where the directory should be');
    },
    secrets: [root, dir],
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

async function s3Harness(): Promise<Harness & { stub: S3Stub }> {
  const stub = await startS3Stub('document-bucket');
  const host = new URL(stub.endpoint).host;
  return {
    stub,
    storage: createStorage({
      backend: 's3',
      bucket: 'document-bucket',
      prefix: 'scrylux/',
      region: 'us-east-1',
      endpoint: stub.endpoint,
      forcePathStyle: true,
      accessKeyId: 'AKIAFAKEACCESSKEY',
      secretAccessKey: 'fake-secret-access-key',
    }),
    plant: (relativeKey, content = 'x', modifiedAt) => {
      stub.seed(`scrylux/${relativeKey}`, content, modifiedAt);
      return Promise.resolve();
    },
    holds: (relativeKey) => Promise.resolve(stub.objects.has(`scrylux/${relativeKey}`)),
    breakIt: () => {
      stub.failNext(1000);
      return Promise.resolve();
    },
    secrets: ['document-bucket', host, 'AKIAFAKEACCESSKEY', 'fake-secret-access-key'],
    close: () => stub.close(),
  };
}

const open: Harness[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});
const make = async <T extends Harness>(promise: Promise<T>): Promise<T> => {
  const harness = await promise;
  open.push(harness);
  return harness;
};

describe('original keys', () => {
  it('are made by newOriginalKey as sources/<uuid>, never from a name', () => {
    expect(key()).toMatch(/^sources\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(key()).not.toBe(key());
  });

  it('are parsed back only from the exact shape', () => {
    const made = key();
    expect(parseOriginalKey(made)).toBe(made);
    for (const bad of [
      '',
      'sources/',
      `sources/${randomUUID()}/extra`,
      `sources/${randomUUID().toUpperCase()}`,
      `tmp/${randomUUID()}`,
      `/sources/${randomUUID()}`,
      `sources/../${randomUUID()}`,
      `sources/${randomUUID()}\n`,
      'sources/design.md',
      `other/${randomUUID()}`,
    ]) {
      expect(parseOriginalKey(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe.each([
  ['the local volume', () => make(localHarness())],
  ['the S3-compatible service', () => make(s3Harness())],
] as const)('%s', (_name, build) => {
  it('stores and returns the bytes, zeros and all', async () => {
    const { storage, holds } = await build();
    const k = key();
    const bytes = Uint8Array.from([0, 1, 2, 255, 0, 0, 7, 128, 0]);
    await storage.put(k, bytes);
    expect(await holds(k)).toBe(true);
    expect(Buffer.from(await storage.get(k))).toEqual(Buffer.from(bytes));
  });

  it('stores an original of the largest size', async () => {
    const { storage } = await build();
    const k = key();
    const big = Buffer.alloc(10 * 1024 * 1024, 0x41);
    await storage.put(k, big);
    expect((await storage.get(k)).length).toBe(big.length);
  });

  it('fails as StorageUnavailable to return a key it does not hold', async () => {
    const { storage } = await build();
    await expect(storage.get(key())).rejects.toBeInstanceOf(StorageUnavailable);
  });

  it('removes a key, and succeeds when it is already gone', async () => {
    const { storage, holds } = await build();
    const k = key();
    await storage.put(k, Buffer.from('secret design'));
    await storage.delete(k);
    expect(await holds(k)).toBe(false);
    await storage.delete(k);
    await storage.delete(key());
  });

  it('lists only the keys it made the shape of, with their modification times', async () => {
    const { storage, plant } = await build();
    const mine = key();
    await storage.put(mine, Buffer.from('a'));
    const old = key();
    await plant(old, 'old', OLD);
    // Things in the same place that are not Scrylux's originals.
    await plant('sources/design.md');
    await plant(`sources/${randomUUID()}.bak`);
    await plant(`sources/${randomUUID()}/nested`);
    await plant('notes.txt');
    await plant(`tmp/${randomUUID()}`);
    const listed = await collect(storage);
    expect(listed.map((item) => item.key).sort()).toEqual([mine, old].sort());
    expect(listed.every((item) => item.modifiedAt instanceof Date)).toBe(true);
    const oldItem = listed.find((item) => item.key === old);
    expect(Math.abs((oldItem?.modifiedAt.getTime() ?? 0) - OLD.getTime())).toBeLessThan(2000);
  });

  it('lists more than a thousand keys', async () => {
    const { storage, plant } = await build();
    const planted: string[] = [];
    for (let i = 0; i < 1105; i++) planted.push(key());
    for (let i = 0; i < planted.length; i += 100) await Promise.all(planted.slice(i, i + 100).map((k) => plant(k)));
    expect((await collect(storage)).map((item) => item.key).sort()).toEqual([...planted].sort());
  }, 60_000);

  it.each(['../escape', 'sources/../../escape', '/etc/passwd', 'sources/design.md', ''])('refuses the key %j, whatever method is asked, and touches nothing', async (forged) => {
    const { storage } = await build();
    const bad = forged as OriginalKey;
    await expect(storage.put(bad, Buffer.from('x'))).rejects.toThrow(TypeError);
    await expect(storage.get(bad)).rejects.toThrow(TypeError);
    await expect(storage.delete(bad)).rejects.toThrow(TypeError);
    expect(await collect(storage)).toEqual([]);
  });

  it('fails as StorageUnavailable when storage is down, with a message that repeats no path, bucket, address, key or credential', async () => {
    const { storage, breakIt, secrets } = await build();
    const k = key();
    await storage.put(k, Buffer.from('x'));
    await breakIt();
    const failures = await Promise.all([
      storage.put(key(), Buffer.from('x')).catch((e: unknown) => e),
      storage.get(k).catch((e: unknown) => e),
      storage.delete(k).catch((e: unknown) => e),
      collect(storage).catch((e: unknown) => e),
    ]);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(StorageUnavailable);
      const text = `${(failure as Error).message} ${JSON.stringify(failure)} ${String((failure as Error).stack).split('\n')[0] ?? ''}`;
      for (const secret of [...secrets, k]) expect(text, secret).not.toContain(secret);
      expect((failure as Error).message.length).toBeGreaterThan(0);
      // A cause would carry the path or the address that the message leaves out.
      expect((failure as Error).cause).toBeUndefined();
    }
  }, 60_000);
});

describe('the local volume', () => {
  it('keeps its files under the directory it was given, as sources/<uuid>', async () => {
    const harness = await make(localHarness());
    const k = key();
    await harness.storage.put(k, Buffer.from('x'));
    expect(await readdir(join(harness.dir, 'sources'))).toEqual([k.slice('sources/'.length)]);
  });

  it('writes to tmp and renames, so no reader sees a partial file: a rename that fails leaves nothing at the key and nothing in tmp', async () => {
    const harness = await make(localHarness());
    const k = key();
    // A directory where the file should land makes the rename fail after the data was written.
    await mkdir(join(harness.dir, k), { recursive: true });
    await expect(harness.storage.put(k, Buffer.from('x'))).rejects.toBeInstanceOf(StorageUnavailable);
    expect((await stat(join(harness.dir, k))).isDirectory()).toBe(true);
    expect(await readdir(join(harness.dir, 'tmp'))).toEqual([]);
  });

  it('removes temporary files older than the age it is given, and keeps fresher ones', async () => {
    const harness = await make(localHarness());
    const stale = randomUUID();
    const fresh = randomUUID();
    await harness.plant(`tmp/${stale}`, 'half a file', OLD);
    await harness.plant(`tmp/${fresh}`, 'being written');
    expect(await harness.storage.cleanupTemporary?.(3_600_000)).toBe(1);
    expect(await harness.holds(`tmp/${stale}`)).toBe(false);
    expect(await harness.holds(`tmp/${fresh}`)).toBe(true);
  });

  it('has nothing to clean in a directory it has not used yet', async () => {
    const harness = await make(localHarness());
    expect(await harness.storage.cleanupTemporary?.(0)).toBe(0);
    expect(await collect(harness.storage)).toEqual([]);
  });
});

describe('the S3-compatible service', () => {
  it('keeps its objects under the prefix, as <prefix>sources/<uuid>', async () => {
    const harness = await make(s3Harness());
    const k = key();
    await harness.storage.put(k, Buffer.from('x'));
    expect([...harness.stub.objects.keys()]).toEqual([`scrylux/${k}`]);
  });

  it('never lists, returns or removes what it did not store: another prefix, or another shape', async () => {
    const harness = await make(s3Harness());
    const elsewhere = `other-team/sources/${randomUUID()}`;
    harness.stub.seed(elsewhere, 'not ours');
    harness.stub.seed('scrylux/keep.txt', 'a neighbour');
    const lookalike = `scrylux-extra/sources/${randomUUID()}`;
    harness.stub.seed(lookalike, 'a prefix that merely starts the same');
    const mine = key();
    await harness.storage.put(mine, Buffer.from('ours'));
    expect((await collect(harness.storage)).map((item) => item.key)).toEqual([mine]);
    await harness.storage.delete(mine);
    expect([...harness.stub.objects.keys()].sort()).toEqual([elsewhere, lookalike, 'scrylux/keep.txt'].sort());
  });

  it('asks only the stub it was pointed at, for the one bucket', async () => {
    const harness = await make(s3Harness());
    await harness.storage.put(key(), Buffer.from('x'));
    expect(harness.stub.requests.length).toBeGreaterThan(0);
    expect(harness.stub.requests.every((line) => line.includes('/document-bucket'))).toBe(true);
  });

  it('has no cleanup of temporary files, because it writes none', async () => {
    const harness = await make(s3Harness());
    expect('cleanupTemporary' in harness.storage).toBe(false);
  });
});
