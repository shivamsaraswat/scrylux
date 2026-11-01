import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The two processes, started for real with a bad source or storage setting (Phase 3 Milestone 3, US7, FR-052): each stops before it
// touches the database, saying which variable is wrong and never what it was set to. The checks themselves are unit-tested in
// sources/config.test.ts, storage/config.test.ts and worker/startup.test.ts; this proves each entry point calls them.

const CWD = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'a-value-that-must-never-be-printed';

function start(entry: 'src/server.ts' | 'src/worker.ts', env: Record<string, string>) {
  // The test setup points STORAGE_DIR at a temporary directory, which the S3 backend would refuse as a leftover.
  const inherited = { ...process.env };
  if (env.STORAGE_BACKEND === 's3') delete inherited.STORAGE_DIR;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--conditions=@scrylux/source', entry], {
    cwd: CWD,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...inherited, PORT: '0', WORKER_HEALTH_PORT: '3999', ...env },
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe.each([['src/server.ts' as const], ['src/worker.ts' as const]])('%s', (entry) => {
  it.each([
    ['SOURCE_MAX_MB', '1000'],
    ['DOCUMENT_SPACE', SECRET],
    ['STORAGE_BACKEND', SECRET],
  ])('stops with the name of a bad %s and not its value', (name, value) => {
    const { status, output } = start(entry, { [name]: value });
    expect(status).toBe(1);
    expect(output).toContain(`Startup failed: ${name}`);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain(value === '1000' ? 'must be 1000' : value);
  }, 70_000);

  it('stops on an S3 backend with no bucket, naming it', () => {
    const { status, output } = start(entry, { STORAGE_BACKEND: 's3', STORAGE_S3_REGION: 'eu-west-1' });
    expect(status).toBe(1);
    expect(output).toContain('STORAGE_S3_BUCKET');
  }, 70_000);

  it('stops on an S3 backend while an AWS variable could send requests elsewhere, naming it and not its value', () => {
    const { status, output } = start(entry, { STORAGE_BACKEND: 's3', STORAGE_S3_BUCKET: 'b', STORAGE_S3_REGION: 'eu-west-1', AWS_ENDPOINT_URL: `https://${SECRET}.example` });
    expect(status).toBe(1);
    expect(output).toContain('AWS_ENDPOINT_URL');
    expect(output).not.toContain(SECRET);
  }, 70_000);
});

it('stops the worker on a bad extraction setting', () => {
  const { status, output } = start('src/worker.ts', { EXTRACT_MEMORY_MB: '12' });
  expect(status).toBe(1);
  expect(output).toContain('Startup failed: EXTRACT_MEMORY_MB');
}, 70_000);
