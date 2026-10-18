import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connectionSettings, escapeIdentifier } from './connection.js';
import { pool, uid } from './helpers.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

const scratchNames: string[] = [];
const scratchPools: pg.Pool[] = [];

export interface LegacyEntry {
  title: string;
  stride_category: string;
  severity: string;
  description: string;
  created_at: string;
}

// Creates an empty database next to the test database and returns a pool connected to it.
export async function scratchDatabase(): Promise<pg.Pool> {
  const name = `scrylux_scratch_${uid()}`;
  await pool().query(`CREATE DATABASE ${escapeIdentifier(name)}`);
  scratchNames.push(name);
  const p = new pg.Pool(connectionSettings(name));
  // The database is dropped with FORCE at the end, which terminates any connection the server is still
  // closing (57P01). That is expected here, and without a listener the pool turns it into an unhandled
  // error that fails the whole run even though every test passed.
  p.on('error', () => undefined);
  scratchPools.push(p);
  return p;
}

// For a file's afterAll, before closePool().
export async function dropScratchDatabases(): Promise<void> {
  await Promise.all(scratchPools.splice(0).map((p) => p.end()));
  for (const name of scratchNames.splice(0)) {
    await pool().query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
  }
}

// Leaves the database exactly as an install from before `file` would have it: every migration that
// sorts before it applied and recorded, nothing else. The list is filtered, never hardcoded, so it
// stays right if an earlier file is ever added. `file` may be a bare prefix such as '009'.
export async function installBefore(p: pg.Pool, file: string): Promise<void> {
  await p.query(`
    CREATE TABLE schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f < file)
    .sort();
  for (const name of files) await applyFile(p, name);
}

// Runs one migration file and records it, as the runner would.
export async function applyFile(p: pg.Pool, file: string): Promise<void> {
  await p.query(fs.readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8'));
  await p.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
}

export async function snapshot(
  p: pg.Pool,
  table: 'users' | 'projects' | 'threat_models' | 'threats' | 'mitigations',
): Promise<unknown[]> {
  const { rows } = await p.query<{ j: unknown }>(
    `SELECT to_jsonb(t) AS j FROM ${escapeIdentifier(table)} t ORDER BY id`,
  );
  return rows.map((r) => r.j);
}

export async function recordedMigrations(p: pg.Pool): Promise<string[]> {
  const { rows } = await p.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
  return rows.map((r) => r.name);
}

export async function tableExists(p: pg.Pool, name: string): Promise<boolean> {
  const { rows } = await p.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [name]);
  return rows[0]?.present ?? false;
}

// Returns the new ids in insertion order.
export async function seedEntries(p: pg.Pool, entries: LegacyEntry[]): Promise<number[]> {
  const ids: number[] = [];
  for (const e of entries) {
    const { rows } = await p.query<{ id: number }>(
      `INSERT INTO threat_entries (title, stride_category, severity, description, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [e.title, e.stride_category, e.severity, e.description, e.created_at],
    );
    const row = rows[0];
    if (!row) throw new Error('seedEntries: insert returned no row');
    ids.push(row.id);
  }
  return ids;
}

export async function seedUsers(p: pg.Pool, usernames: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const username of usernames) {
    const { rows } = await p.query<{ id: number }>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, 'not-a-real-hash'],
    );
    const row = rows[0];
    if (!row) throw new Error('seedUsers: insert returned no row');
    ids.push(row.id);
  }
  return ids;
}
