import type { StorageConfig } from './config.js';
import { createLocalStorage } from './local.js';
import { createS3Storage } from './s3.js';
import type { Storage } from './types.js';

export { StorageUnavailable, assertOriginalKey, newOriginalKey, parseOriginalKey } from './types.js';
export type { OriginalKey, Storage, StoredOriginal } from './types.js';

/** The backend the operator chose (STORAGE_BACKEND). Neither backend contacts anything until it is used. */
export function createStorage(config: StorageConfig): Storage {
  return config.backend === 'local' ? createLocalStorage(config.dir) : createS3Storage(config);
}
