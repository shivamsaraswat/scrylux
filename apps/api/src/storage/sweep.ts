import type { Database } from '@scrylux/db';
import type { Kysely } from 'kysely';
import type { Storage } from './types.js';

// The storage sweep (Phase 3 Milestone 3, FR-055, contracts/storage.md): the worker removes what no source needs. An original that
// could not be removed when its source was deleted, one left by a crash between the put and the insert, and a half-written
// file of the local volume all end up here. A key younger than the grace is never touched: an upload may have stored its bytes and
// not yet written its row. Safe to run in several workers at once, because removing a key that is already gone succeeds.

/** How old a key or a temporary file must be before the sweep may remove it. */
// Exported for tests: tests age objects by it.
export const SWEEP_GRACE_MS = 60 * 60 * 1000;

export interface SweepResult {
  listed: number;
  deleted: number;
  failed: number;
  /** Half-written files of the local volume that were removed. */
  temporary: number;
}

/**
 * Removes every stored original older than the grace that no source that is not ready still needs. Never throws: storage being
 * down is counted as a failure and the next sweep tries again. Logs one line, with counts only.
 */
export async function sweepStorage(db: Kysely<Database>, storage: Storage, options: { graceMs?: number; now?: () => number } = {}): Promise<SweepResult> {
  const graceMs = options.graceMs ?? SWEEP_GRACE_MS;
  const now = options.now ?? Date.now;
  const result: SweepResult = { listed: 0, deleted: 0, failed: 0, temporary: 0 };
  try {
    for await (const item of storage.list()) {
      result.listed += 1;
      if (now() - item.modifiedAt.getTime() < graceMs) continue;
      try {
        const needed = await db.selectFrom('sources').select('id').where('original_key', '=', item.key).executeTakeFirst();
        if (needed !== undefined) continue;
        await storage.delete(item.key);
        result.deleted += 1;
      } catch {
        result.failed += 1;
      }
    }
    if (storage.cleanupTemporary !== undefined) result.temporary = await storage.cleanupTemporary(graceMs);
  } catch {
    // Storage could not be listed: nothing is known to be wrong with any key, and the next sweep tries again.
    result.failed += 1;
  }
  console.log(JSON.stringify({ event: 'storage_sweep', ...result }));
  return result;
}
