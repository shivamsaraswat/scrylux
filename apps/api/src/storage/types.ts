import { randomUUID } from 'node:crypto';

// The storage abstraction (Phase 3 Milestone 3, FR-050, specs/phase-3/milestone-3-ingestion/contracts/storage.md). The
// API stores the originals of uploads and deletes them; the worker reads them, deletes them once a source is ready, and
// sweeps what no source needs. Nothing outside this directory knows whether they sit on a volume or in a bucket, and
// nothing derived from a file name or a request ever becomes a key (FR-008).

/** The key of a stored original: `sources/<uuid>`, made only by newOriginalKey or parsed from a listed key. */
export type OriginalKey = string & { readonly __brand: 'OriginalKey' };

const KEY_PATTERN = /^sources\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const newOriginalKey = (): OriginalKey => `sources/${randomUUID()}` as OriginalKey;

/** The key, if the text has exactly the shape of one. */
export const parseOriginalKey = (text: string): OriginalKey | undefined => (KEY_PATTERN.test(text) ? (text as OriginalKey) : undefined);

/** Every method refuses a key that did not come from newOriginalKey or parseOriginalKey, before it touches anything. */
export function assertOriginalKey(key: string): OriginalKey {
  const valid = parseOriginalKey(key);
  if (valid === undefined) throw new TypeError('not the key of a stored original');
  return valid;
}

/**
 * Storage could not do what was asked: it is down, full, misconfigured or does not hold the key. The message is fixed
 * and there is no cause, because the original error holds a path, a bucket, an address or a credential (Principle I).
 * The worker runs the job again after a wait (FR-013).
 */
export class StorageUnavailable extends Error {
  constructor() {
    super('Storage is unavailable');
    this.name = 'StorageUnavailable';
  }
}

export interface StoredOriginal {
  key: OriginalKey;
  modifiedAt: Date;
}

export interface Storage {
  /** Stores the bytes under the key. Keys are fresh UUIDs, so nothing is replaced in practice. */
  put(key: OriginalKey, bytes: Uint8Array): Promise<void>;
  /** The bytes, or a StorageUnavailable, also when storage does not hold the key. */
  get(key: OriginalKey): Promise<Uint8Array>;
  /** Removes the key. Succeeds when it is already gone. */
  delete(key: OriginalKey): Promise<void>;
  /** Every original Scrylux stored, with when. Anything of another shape, or elsewhere, is not returned. */
  list(): AsyncIterable<StoredOriginal>;
  /** The local volume writes files to a temporary place first; this removes the ones older than the age. S3 has none. */
  cleanupTemporary?(olderThanMs: number): Promise<number>;
}
