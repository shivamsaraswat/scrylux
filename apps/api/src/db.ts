// Created on first use so config.load() (Secrets Manager) can run first.
// The pool connects lazily, so the process (and /health) starts even if the DB is down.
//
// All queries through this module MUST use parameterized `pg` calls or the typed Kysely builder —
// never string-built or template-interpolated SQL (constitution Principle I, NON-NEGOTIABLE). The
// domain tables (/api/v1) go through `kdb`; login, users and admin seeding stay on `db.query`.
import type { Database } from '@scrylux/db';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import config from './config.js';

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool(config.db);
    pool.on('error', (err) => {
      console.error('Unexpected Postgres pool error:', err.message);
    });
  }
  return pool;
}

const db = {
  query: ((...args: Parameters<Pool['query']>) => getPool().query(...args)) as Pool['query'],
  connect: ((...args: Parameters<Pool['connect']>) => getPool().connect(...args)) as Pool['connect'],
  end: (): Promise<void> => (pool ? pool.end() : Promise.resolve()),
};

// Shares the pool above, so it connects lazily too. Never call kdb.destroy(): it would end the pool
// that login and users use. db.end() is the one place the pool is closed.
export const kdb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: () => Promise.resolve(getPool()) }) });

export default db;
