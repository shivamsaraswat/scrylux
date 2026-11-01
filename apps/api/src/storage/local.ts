import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StorageUnavailable, assertOriginalKey, parseOriginalKey, type OriginalKey, type Storage, type StoredOriginal } from './types.js';

// Originals on a local volume (STORAGE_DIR), as <dir>/sources/<uuid>. The app and the worker share the directory, so a
// file is written to <dir>/tmp/<uuid> and renamed into place: the worker never reads a half-written file. Files and
// directories are readable by their owner only, because an original can be a confidential document.

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

export function createLocalStorage(dir: string): Storage {
  const root = resolve(dir);
  const sources = join(root, 'sources');
  const temporary = join(root, 'tmp');
  // The key was checked by assertOriginalKey, so this cannot leave the directory.
  const pathOf = (key: OriginalKey): string => join(root, key);

  return {
    async put(key, bytes) {
      assertOriginalKey(key);
      try {
        await mkdir(sources, { recursive: true, mode: 0o700 });
        await mkdir(temporary, { recursive: true, mode: 0o700 });
        const partial = join(temporary, randomUUID());
        const file = await open(partial, 'wx', 0o600);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await rename(partial, pathOf(key));
        } catch (error) {
          await rm(partial, { force: true });
          throw error;
        }
      } catch {
        throw new StorageUnavailable();
      }
    },

    async get(key) {
      assertOriginalKey(key);
      try {
        return await readFile(pathOf(key));
      } catch {
        throw new StorageUnavailable();
      }
    },

    async delete(key) {
      assertOriginalKey(key);
      try {
        await rm(pathOf(key), { force: false });
      } catch (error) {
        if (!isMissing(error)) throw new StorageUnavailable();
      }
    },

    async *list(): AsyncGenerator<StoredOriginal> {
      let entries;
      try {
        entries = await readdir(sources, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return;
        throw new StorageUnavailable();
      }
      for (const entry of entries) {
        const key = entry.isFile() ? parseOriginalKey(`sources/${entry.name}`) : undefined;
        if (key === undefined) continue;
        let modifiedAt: Date;
        try {
          modifiedAt = (await stat(pathOf(key))).mtime;
        } catch (error) {
          // Removed between the listing and now: it is not an original any more.
          if (isMissing(error)) continue;
          throw new StorageUnavailable();
        }
        yield { key, modifiedAt };
      }
    },

    async cleanupTemporary(olderThanMs) {
      let names: string[];
      try {
        names = await readdir(temporary);
      } catch (error) {
        if (isMissing(error)) return 0;
        throw new StorageUnavailable();
      }
      const cutoff = Date.now() - olderThanMs;
      let removed = 0;
      for (const name of names) {
        try {
          const path = join(temporary, name);
          if ((await stat(path)).mtimeMs < cutoff) {
            await rm(path, { force: true });
            removed += 1;
          }
        } catch (error) {
          if (!isMissing(error)) throw new StorageUnavailable();
        }
      }
      return removed;
    },
  };
}
