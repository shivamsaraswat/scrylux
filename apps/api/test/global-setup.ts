import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Runs once before the test suite, in Vitest's main process (not a worker), so a fresh
// database (a new CI service container, or a freshly `docker compose up`'d volume) has a
// schema and an admin user before any contract test tries to log in. Without this, the
// DB-backed tests silently depended on someone having migrated the volume beforehand
// (research.md #4).
export default async function setup(): Promise<() => Promise<void>> {
  // Loads .env.test (repo root) if present, matching env.setup.ts's pattern. It is gitignored,
  // so CI won't have it; CI supplies the same throwaway values directly as job `env:` (research.md
  // #1), and process.loadEnvFile() never overwrites a variable that's already set.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envFile = path.join(__dirname, '..', '..', '..', '.env.test');
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Missing file or unsupported Node version — fall back to whatever the shell already exports.
  }

  // The directory that holds the temporary storage of every test process (env.setup.ts), so that one removal at the end of the run
  // leaves none behind. The workers start after this and inherit it. Skipped when the shell chose where originals go.
  const storageParent = process.env.STORAGE_DIR ? undefined : mkdtempSync(path.join(tmpdir(), 'scrylux-test-storage-'));
  if (storageParent !== undefined) process.env.SCRYLUX_TEST_STORAGE_PARENT = storageParent;

  // config.ts reads process.env into a module-level object at import time, not lazily. A static
  // top-level `import` here would be hoisted and evaluated before the env-loading code above
  // runs, capturing empty values. These are dynamic imports, deliberately, so they resolve only
  // after `.env.test` (or the CI-provided env) is in place.
  const [{ default: config }, { default: db }, { default: migrate }, { seedAdminUser }] = await Promise.all([
    import('../src/config.js'),
    import('../src/db.js'),
    import('../src/migrate.js'),
    import('../src/auth.js'),
  ]);

  let startedAt: Date;
  try {
    await config.load();
    await migrate();
    await seedAdminUser();
    // Every test signs in from 127.0.0.1, so failures counted in an earlier local run would add up
    // against the sign-in limits. Starting from an empty table keeps re-runs independent.
    await db.query('DELETE FROM sign_in_throttle');
    // The database's own clock, so this agrees with the created_at that storage assigns.
    const { rows } = await db.query<{ now: Date }>('SELECT now() AS now');
    startedAt = rows[0]?.now ?? new Date();
  } finally {
    // Closing the pool is required: an open handle here can keep Vitest's main process alive
    // past the last test, until the job's timeout (FR-010) kills it.
    await db.end();
  }

  // The v1 tests create projects and never delete them, and these tests share a database with
  // `docker compose up` locally. Deleting every project created during the run (a delete cascades
  // to what is inside it) keeps a developer's project list free of test data. The session tests
  // create their own accounts (named m6-test-*, so no test ends `admin`'s sessions): those, and the
  // sessions and projects they own, go too. Nothing here touches any other user, or anything
  // created before the run started, except what a crashed earlier run left under an m6-test-* account.
  return async function teardown(): Promise<void> {
    if (storageParent !== undefined) rmSync(storageParent, { recursive: true, force: true });
    const pool = new pg.Pool(config.db);
    try {
      await pool.query('DELETE FROM browser_sessions WHERE created_at >= $1', [startedAt]);
      // Failed sign-ins from the tests are counted against 127.0.0.1 and the documentation addresses.
      await pool.query('DELETE FROM sign_in_throttle');
      await pool.query('DELETE FROM projects WHERE created_at >= $1', [startedAt]);
      // projects.created_by is ON DELETE RESTRICT, so a project left by a crashed run (it predates
      // startedAt, so the delete above misses it) would make the user delete below throw.
      await pool.query(
        `DELETE FROM projects WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'm6-test-%')`,
      );
      // Phase 3 Milestone 2: the job tests (and the browser spec for jobs) start jobs under these accounts, and jobs.created_by and
      // jobs.cancelled_by are ON DELETE RESTRICT too. The job tests' own accounts are named jobs-test-*.
      const testUsers = `SELECT id FROM users WHERE username LIKE 'm6-test-%' OR username LIKE 'jobs-test-%'`;
      await pool.query(`DELETE FROM jobs WHERE created_by IN (${testUsers}) OR cancelled_by IN (${testUsers})`);
      await pool.query(`DELETE FROM users WHERE username LIKE 'm6-test-%' OR username LIKE 'jobs-test-%'`);
    } finally {
      await pool.end();
    }
  };
}
