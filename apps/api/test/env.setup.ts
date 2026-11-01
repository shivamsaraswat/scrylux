import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Loads .env.test (repo root) for local test runs, matching docker-compose.yml's dev defaults
// (research.md #7). Optional: CI or a host may already export these directly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(__dirname, '..', '..', '..', '.env.test');

try {
  process.loadEnvFile(envFile);
} catch {
  // Missing file or unsupported Node version — fall back to whatever the shell already exports.
}

// Originals of added documents are confidential, so no test writes them into the working tree: every test process gets a
// fresh temporary directory, unless a test or the shell chose one (Phase 3 Milestone 3, FR-050). The directories are made inside the
// one that global-setup.ts makes for the run and removes at its end, so none is left behind; run without it, they sit in the
// system's temporary directory.
if (!process.env.STORAGE_DIR) {
  process.env.STORAGE_DIR = mkdtempSync(path.join(process.env.SCRYLUX_TEST_STORAGE_PARENT ?? tmpdir(), 'scrylux-storage-'));
}
