import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Loads the repo root's .env.test for local runs. It is gitignored: CI supplies the same throwaway
// values as job env, and process.loadEnvFile() never overwrites a variable that is already set.
const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(here, '..', '..', '.env.test'));
} catch {
  // Missing file: fall back to whatever the shell already exports.
}

const PORT = '3100';
const WORKER_SPECS = /(jobs|sources)\.spec\.ts$/;
// Set PLAYWRIGHT_BASE_URL to run a spec against an app that is already running, such as
// `docker compose up` on http://localhost:3000. No server is started then.
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  // The specs that start a worker of their own run after the others, one file at a time: a worker takes any job in the shared
  // database, so two of them at once (or one beside a spec that expects none) would answer each other's jobs. Everything else
  // runs with no worker and no provider (Phase 3 Milestone 2 SC-001, Milestone 3 SC-001).
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: WORKER_SPECS },
    { name: 'jobs', use: { browserName: 'chromium' }, testMatch: /jobs\.spec\.ts$/, dependencies: ['chromium'] },
    { name: 'sources', use: { browserName: 'chromium' }, testMatch: /sources\.spec\.ts$/, dependencies: ['jobs'] },
  ],
  // The *built* app: only it has the CSP headers and serves the UI. The Vite dev server applies neither.
  webServer: externalBaseUrl
    ? undefined
    : {
        command: 'node ../api/dist/server.js',
        url: `http://localhost:${PORT}/health`,
        reuseExistingServer: !process.env.CI,
        env: { ...(process.env as Record<string, string>), PORT },
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
