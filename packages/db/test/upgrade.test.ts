import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/index.js';
import { connectionSettings, escapeIdentifier } from './connection.js';
import { closePool, pool, uid } from './helpers.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const migrationFiles = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const LEGACY_FILES = ['001_threat_entries.sql', '002_users.sql'];
const LATER_FILES = migrationFiles.filter((f) => f > '002_users.sql');
const DOMAIN_TABLES = ['projects', 'threat_models', 'elements', 'threats', 'mitigations'];

const scratch: string[] = [];
const openPools: pg.Pool[] = [];

// Creates an empty database next to the test database and returns a pool connected to it.
async function scratchDatabase(): Promise<pg.Pool> {
  const name = `scrylux_upgrade_${uid()}`;
  await pool().query(`CREATE DATABASE ${escapeIdentifier(name)}`);
  scratch.push(name);
  const p = new pg.Pool(connectionSettings(name));
  // The database is dropped with FORCE at the end, which terminates a connection the server is still closing
  // (57P01). That is expected, and without a listener the pool turns it into an unhandled error that fails
  // the whole run even though every test passed (the same guard as scratch.ts).
  p.on('error', () => undefined);
  openPools.push(p);
  return p;
}

// Leaves the database exactly as an install from before this milestone would have it: the legacy
// migrations applied and recorded, nothing else.
async function installPreMilestone(p: pg.Pool): Promise<void> {
  await p.query(`
    CREATE TABLE schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  for (const file of LEGACY_FILES) {
    await p.query(fs.readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8'));
    await p.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
  }
}

async function recordedMigrations(p: pg.Pool): Promise<Array<{ name: string; applied_at: Date }>> {
  const { rows } = await p.query<{ name: string; applied_at: Date }>(
    'SELECT name, applied_at FROM schema_migrations ORDER BY name',
  );
  return rows;
}

async function snapshot(p: pg.Pool, table: 'users'): Promise<unknown[]> {
  const { rows } = await p.query<{ j: unknown }>(`SELECT to_jsonb(t) AS j FROM ${escapeIdentifier(table)} t ORDER BY id`);
  return rows.map((r) => r.j);
}

async function tablesPresent(p: pg.Pool, tables: string[]): Promise<Record<string, string | null>> {
  const { rows } = await p.query<{ t: string; r: string | null }>(
    `SELECT t, to_regclass(t)::text AS r FROM unnest($1::text[]) AS t`,
    [tables],
  );
  return Object.fromEntries(rows.map((r) => [r.t, r.r]));
}

afterAll(async () => {
  await Promise.all(openPools.map((p) => p.end()));
  for (const name of scratch) await pool().query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
  await closePool();
});

describe('upgrading an install from before this milestone (US1, FR-001, FR-003)', () => {
  let upgraded: pg.Pool;
  let usersBefore: unknown[];
  let legacyAppliedAtBefore: Array<{ name: string; applied_at: Date }>;
  let recordedAfterFirstRun: Array<{ name: string; applied_at: Date }>;

  beforeAll(async () => {
    upgraded = await scratchDatabase();
    await installPreMilestone(upgraded);

    await upgraded.query(`INSERT INTO users (username, password_hash) VALUES ('alice', 'h1'), ('bob', 'h2')`);
    await upgraded.query(
      `INSERT INTO threat_entries (title, stride_category, severity, description) VALUES
         ('Spoofed login',   'Spoofing',               'High',   'plain'),
         ('Edited payload',  'Tampering',              'Medium', E'line one\nline two\n'),
         ('Missing audit',   'Repudiation',            'Low',    ''),
         ($1,                'Information Disclosure', 'High',   'very long title')`,
      ['T'.repeat(90_000)],
    );

    usersBefore = await snapshot(upgraded, 'users');
    legacyAppliedAtBefore = (await recordedMigrations(upgraded)).filter((m) => LEGACY_FILES.includes(m.name));

    await migrate(upgraded);
    recordedAfterFirstRun = await recordedMigrations(upgraded);
  });

  it('creates the new domain tables (scenario 1)', async () => {
    const present = await tablesPresent(upgraded, DOMAIN_TABLES);
    expect(present).toEqual(Object.fromEntries(DOMAIN_TABLES.map((t) => [t, t])));
  });

  it('leaves every user account unchanged, and ends with no legacy entry table (scenarios 1 and 2, SC-001; Milestone 5 removes it)', async () => {
    expect(await snapshot(upgraded, 'users')).toEqual(usersBefore);
    expect(usersBefore).toHaveLength(2);
    expect(await tablesPresent(upgraded, ['threat_entries'])).toEqual({ threat_entries: null });
  });

  it('does not re-apply the legacy migrations and records every later one', () => {
    const legacyAfter = recordedAfterFirstRun.filter((m) => LEGACY_FILES.includes(m.name));
    expect(legacyAfter).toEqual(legacyAppliedAtBefore);
    expect(LATER_FILES.length).toBeGreaterThan(0);
    expect(recordedAfterFirstRun.map((m) => m.name)).toEqual(migrationFiles);
  });

  it('applies nothing on a restart (scenario 4)', async () => {
    await migrate(upgraded);
    expect(await recordedMigrations(upgraded)).toEqual(recordedAfterFirstRun);
  });
});

describe('a brand-new install (US1, SC-002)', () => {
  it('gets the users and domain structures, and no legacy table, in a single run (scenario 3)', async () => {
    const empty = await scratchDatabase();
    await migrate(empty);

    const present = await tablesPresent(empty, ['threat_entries', 'users', ...DOMAIN_TABLES]);
    expect(present.threat_entries).toBeNull();
    expect(Object.entries(present).filter(([table]) => table !== 'threat_entries').every(([, r]) => r !== null)).toBe(
      true,
    );
    expect((await recordedMigrations(empty)).map((m) => m.name)).toEqual(migrationFiles);
  });
});

describe('two instances starting at the same moment (spec edge case, FR-001, FR-004)', () => {
  it('applies every schema change exactly once', async () => {
    const empty = await scratchDatabase();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await Promise.all([migrate(empty), migrate(empty)]);

      const applied = log.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('Applied migration '))
        .sort();
      expect(applied).toEqual(migrationFiles.map((file) => `Applied migration ${file}`));
    } finally {
      log.mockRestore();
    }

    expect((await recordedMigrations(empty)).map((m) => m.name)).toEqual(migrationFiles);
    const present = await tablesPresent(empty, DOMAIN_TABLES);
    expect(Object.values(present).every((r) => r !== null)).toBe(true);
  });
});

describe('a schema change that fails partway (US1 scenario 5, FR-004)', () => {
  it('leaves nothing from that file behind, does not record it, and reports the failure', async () => {
    const broken = await scratchDatabase();
    // 003 creates set_timestamps() and then element_class(). Pre-creating the second makes 003 fail
    // on its second statement, after its first has already run.
    await broken.query(`CREATE FUNCTION element_class(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT t $$`);

    await expect(migrate(broken)).rejects.toThrow();

    const { rows } = await broken.query<{ f: string | null }>(`SELECT to_regprocedure('set_timestamps()')::text AS f`);
    expect(rows[0]?.f).toBeNull();
    const recorded = (await recordedMigrations(broken)).map((m) => m.name);
    expect(recorded).toEqual(LEGACY_FILES);
    expect(recorded).not.toContain('003_domain_functions.sql');
  });
});
