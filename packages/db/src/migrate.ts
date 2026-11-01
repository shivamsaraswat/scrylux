import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';

// Resolved relative to this module, so it works from src/ in development and from dist/ in the image.
const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
// Arbitrary constant so concurrent instances starting together run migrations one at a time.
const LOCK_ID = 727274;

/**
 * A migration that stopped on purpose, with a message written for an operator (SQLSTATE class SX): Scrylux's own
 * migrations raise it with fixed text, so it is safe to print. Every other failure carries driver text, which may hold
 * a query or a value derived from the configuration, and is never printed (Phase 3 Milestone 3, FR-091, research #16).
 */
export class MigrationRefusedError extends Error {
  constructor(
    message: string,
    readonly code: 'SX001' | 'SX002',
  ) {
    super(message);
    this.name = 'MigrationRefusedError';
  }
}

function refusal(err: unknown): MigrationRefusedError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if ((code === 'SX001' || code === 'SX002') && typeof message === 'string') return new MigrationRefusedError(message, code);
  return undefined;
}

export interface MigrationPool {
  connect(): Promise<PoolClient>;
}

export async function migrate(pool: MigrationPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw refusal(err) ?? err;
      }
      console.log(`Applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}
