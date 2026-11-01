import { parseStorageConfig } from './config.js';
import { createStorage } from './index.js';
import type { Storage } from './types.js';

// The storage this process uses (Phase 3 Milestone 3), a module-level instance like the database pool: `server.ts` and
// `worker.ts` choose it once they have loaded the configuration, with the keys that came from the secrets manager. A test
// that never chose one gets the local volume at STORAGE_DIR, which the test setup points at a temporary directory.

let current: Storage | undefined;

/** Chooses the storage of this process. */
export function useStorage(storage: Storage): void {
  current = storage;
}

/** The storage of this process. */
export function storage(): Storage {
  current ??= createStorage(parseStorageConfig(process.env));
  return current;
}
