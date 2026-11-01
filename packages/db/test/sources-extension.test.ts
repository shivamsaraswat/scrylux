import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MigrationRefusedError, migrate } from '../src/index.js';
import type { MigrationPool } from '../src/migrate.js';
import { TEST_DB, connectionSettings, escapeIdentifier } from './connection.js';
import { uid } from './helpers.js';

// Migration 017 needs the pgvector extension and says plainly when it cannot have it (Phase 3 Milestone 3, FR-091,
// research #16). Each case runs on a scratch database that holds migrations 001 to 016 only, as an install upgrading from
// Milestone 2 does, so 017 is the one migration the case applies.

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const FIRST_NEW = '017_sources.sql';

const scratch: { db?: string; role?: string } = {};
const maintenance = new pg.Client(connectionSettings(process.env.DB_NAME ?? 'postgres'));
const admin = (): pg.Client => maintenance;

// A connection that the scratch database's removal ends while it is idle reports it as an event, which would otherwise be an unhandled error.
function quietPool(settings: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(settings);
  pool.on('error', () => undefined);
  return pool;
}

beforeAll(() => maintenance.connect());
afterAll(() => maintenance.end());

/** A fresh database with migrations 001 to 016 applied by hand, so that 017 is still to come. */
async function upgradeable(): Promise<string> {
  const db = `${TEST_DB}_ext_${uid()}`;
  scratch.db = db;
  await admin().query(`CREATE DATABASE ${escapeIdentifier(db)}`);
  const pool = quietPool(connectionSettings(db));
  try {
    await pool.query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f < FIRST_NEW).sort();
    for (const file of files) {
      await pool.query(fs.readFileSync(`${MIGRATIONS}${file}`, 'utf8'));
      await pool.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
  } finally {
    await pool.end();
  }
  return db;
}

async function state(db: string): Promise<{ migrations: string[]; sources: boolean; extension: boolean }> {
  const pool = quietPool(connectionSettings(db));
  try {
    const migrations = (await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);
    const sources = (await pool.query(`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sources'`)).rows.length === 1;
    const extension = (await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)).rows.length === 1;
    return { migrations, sources, extension };
  } finally {
    await pool.end();
  }
}

/**
 * A pool whose connections see no extension as available, by rewriting the one view the migration reads. The real
 * statements of 017 run unchanged otherwise.
 */
function withoutExtensions(real: pg.Pool): MigrationPool {
  const none = '(SELECT NULL::text AS name WHERE false) AS pg_available_extensions';
  return {
    async connect() {
      const client = await real.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') {
            return (text: unknown, ...rest: unknown[]) =>
              (target.query as (...args: unknown[]) => unknown)(typeof text === 'string' ? text.replaceAll('pg_available_extensions', none) : text, ...rest);
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
}

afterEach(async () => {
  const client = admin();
  if (scratch.db) await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(scratch.db)} WITH (FORCE)`);
  if (scratch.role) await client.query(`DROP ROLE IF EXISTS ${escapeIdentifier(scratch.role)}`);
  scratch.db = undefined;
  scratch.role = undefined;
});

describe('a database that does not have the extension (SX001)', () => {
  it('refuses 017 with a message that names pgvector and the upgrade notes, and changes nothing', async () => {
    const db = await upgradeable();
    const before = await state(db);
    const pool = quietPool(connectionSettings(db));
    try {
      const refused = await migrate(withoutExtensions(pool)).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(MigrationRefusedError);
      const error = refused as MigrationRefusedError;
      expect(error.code).toBe('SX001');
      expect(error.message).toContain('pgvector');
      expect(error.message).toContain('docs/install.md#upgrading-to-v02');
      expect(error.message).not.toContain('does not allow');
    } finally {
      await pool.end();
    }
    const after = await state(db);
    expect(after).toEqual(before);
    expect(after.sources).toBe(false);
    expect(after.migrations).not.toContain(FIRST_NEW);
  });
});

describe('a database that has the extension but a user who may not enable it (SX002)', () => {
  it('refuses 017 with a message that says so, which differs from SX001, and changes nothing', async () => {
    const db = await upgradeable();
    const role = `scrylux_limited_${uid()}`;
    scratch.role = role;
    const password = `pw-${uid()}`;
    const client = admin();
    await client.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD '${password}'`);
    // The role can use and create in the public schema and owns the tables, as the application's user does, but has no
    // right to create anything in the database itself, which enabling an extension takes.
    const owner = new pg.Client(connectionSettings(db));
    owner.on('error', () => undefined);
    await owner.connect();
    try {
      const { rows } = await owner.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
      for (const { tablename } of rows) await owner.query(`ALTER TABLE ${escapeIdentifier(tablename)} OWNER TO ${escapeIdentifier(role)}`);
      await owner.query(`ALTER SCHEMA public OWNER TO ${escapeIdentifier(role)}`);
      await owner.query(`REVOKE CREATE ON DATABASE ${escapeIdentifier(db)} FROM PUBLIC`);
    } finally {
      await owner.end();
    }

    const before = await state(db);
    const pool = quietPool({ ...connectionSettings(db), user: role, password });
    let refused: unknown;
    try {
      refused = await migrate(pool).catch((error: unknown) => error);
    } finally {
      await pool.end();
    }
    expect(refused).toBeInstanceOf(MigrationRefusedError);
    const error = refused as MigrationRefusedError;
    expect(error.code).toBe('SX002');
    expect(error.message).toContain('may not enable it');
    expect(error.message).toContain('CREATE EXTENSION vector');
    expect(error.message).toContain('docs/install.md#upgrading-to-v02');
    expect(await state(db)).toEqual(before);
  });
});

describe('every other failure', () => {
  it('is not a refusal, so no text of it is ever printed (research #16)', async () => {
    const db = await upgradeable();
    const pool = quietPool(connectionSettings(db));
    try {
      const failing: MigrationPool = {
        async connect() {
          const client = await pool.connect();
          return new Proxy(client, {
            get(target, property) {
              if (property === 'query') {
                return (text: unknown, ...rest: unknown[]) => {
                  if (typeof text === 'string' && text.includes('CREATE EXTENSION')) {
                    return Promise.reject(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }));
                  }
                  return (target.query as (...args: unknown[]) => unknown)(text, ...rest);
                };
              }
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            },
          });
        },
      };
      const error = await migrate(failing).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(MigrationRefusedError);
    } finally {
      await pool.end();
    }
    expect((await state(db)).sources).toBe(false);
  });
});
