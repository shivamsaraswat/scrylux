import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import config, { parseSessionConfig } from './config.js';
import { createApp } from './app.js';
import migrate from './migrate.js';
import { seedAdminUser } from './auth.js';
import { checkJobConfig } from './jobs/config.js';
import { checkLlmConfig } from './llm-startup.js';
import { checkSourceConfig } from './sources/config.js';
import { checkStorageConfig, storageEnvironment } from './storage/config.js';
import { createStorage } from './storage/index.js';
import { useStorage } from './storage/instance.js';
import { isRefusal, startupFailureLine } from './startup-failure.js';

// The built web app, resolved relative to this module (never an absolute path, Principle IV). From
// apps/api/src and from apps/api/dist this reaches apps/web/dist, and the image keeps that layout.
const WEB_ROOT = fileURLToPath(new URL('../../web/dist/', import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The DB may still be starting when the app boots (compose, ECS), so retry a few times.
async function initDatabase(attempts = 10): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await migrate();
      await seedAdminUser();
      return;
    } catch (err) {
      // A refusal an operator has to act on is not a database that is still starting.
      if (i >= attempts || isRefusal(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`Database not ready (attempt ${i}/${attempts}): ${message}`);
      await sleep(2000);
    }
  }
}

async function main(): Promise<void> {
  await config.load();
  if (!config.jwtSecret) {
    // Hardcoded, literal message — safe to log directly, unlike the generic catch-all
    // below (which may be reached by DB/secrets-manager errors carrying env-derived data).
    console.error('Startup failed: JWT_SECRET must be set');
    process.exit(1);
    return;
  }
  try {
    parseSessionConfig(process.env);
  } catch {
    // The error message names the variable but never its value, yet a fixed line is still the
    // safest thing to log here, like the JWT_SECRET check above.
    console.error('Startup failed: invalid session or sign-in configuration');
    process.exit(1);
    return;
  }
  // The AI provider layer (Phase 3): validated here, never contacted. With nothing set, Scrylux is v0.1.
  const llm = checkLlmConfig(process.env, config);
  if (!llm.ok) {
    console.error(llm.line);
    process.exit(1);
    return;
  }
  console.log(llm.line);
  // The job settings (Phase 3 Milestone 2): the API copies them onto every job it queues, so a bad value stops it here.
  const jobs = checkJobConfig(process.env);
  if (!jobs.ok) {
    console.error(jobs.line);
    process.exit(1);
    return;
  }
  // The source and storage settings (Phase 3 Milestone 3): the API enforces the limits and stores the originals, so a bad
  // value stops it here, naming the variable and never its value.
  const sources = checkSourceConfig(process.env);
  if (!sources.ok) {
    console.error(sources.line);
    process.exit(1);
    return;
  }
  const storage = checkStorageConfig(storageEnvironment(process.env, config));
  if (!storage.ok) {
    console.error(storage.line);
    process.exit(1);
    return;
  }
  useStorage(createStorage(storage.config));
  await initDatabase();

  // Without a build, such as the API run alone in development, only the API is served. The line is
  // fixed on purpose: it never includes the path.
  const hasWeb = fs.existsSync(`${WEB_ROOT}index.html`);
  if (!hasWeb) console.warn('UI not built (apps/web/dist missing); serving the API only');

  const server = createApp({ trustProxy: config.trustProxy, webRoot: hasWeb ? WEB_ROOT : undefined }).listen(config.port, () => {
    console.log(`Listening on port ${config.port}`);
  });

  function shutdown(signal: string): void {
    console.log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // No error detail logged here on purpose: this is the top-level catch-all, and any
  // property of the caught value could carry driver-attached data derived from
  // env-sourced config (connection string, query text). The DB-readiness retry loop
  // above already logs its own failures in detail before giving up. A migration that
  // stopped on purpose is the one exception: its message was written for the operator.
  console.error(startupFailureLine('Startup failed', error));
  process.exit(1);
});
