import { createLlm } from '@scrylux/llm';
import config from './config.js';
import db, { kdb } from './db.js';
import migrate from './migrate.js';
import { startHealthServer } from './worker/health.js';
import { startWorker } from './worker/loop.js';
import { isRefusal, startupFailureLine } from './startup-failure.js';
import { createStorage } from './storage/index.js';
import { useStorage } from './storage/instance.js';
import { checkWorkerStartup } from './worker/startup.js';

// The worker's entry point (Phase 3 Milestone 2, FR-001, contracts/worker.md): `node dist/worker.js`, from the same image
// as the app. It imports the configuration and the database, never Express or a route. It checks its configuration like
// the API does, with the keys required, and refuses to start with a message that names the setting and never its value.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The database may still be starting when the worker boots (compose, ECS). Whichever of the API and the worker starts
// first applies the migrations; the other waits on the migrator's lock. The line is fixed: the error may carry what the
// driver was given.
async function initDatabase(attempts = 10): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await migrate();
      return;
    } catch (err) {
      // A refusal an operator has to act on is not a database that is still starting.
      if (i >= attempts || isRefusal(err)) throw err;
      console.warn(`Database not ready (attempt ${i}/${attempts})`);
      await sleep(2000);
    }
  }
}

async function main(): Promise<void> {
  try {
    await config.load();
  } catch {
    // Fixed, like the server's: the error may carry the secret's id or the provider's text.
    console.error('Startup failed: could not read the secrets-manager secret named by DB_SECRET_ID');
    process.exit(1);
    return;
  }

  const startup = checkWorkerStartup(process.env, config);
  if (!startup.ok) {
    console.error(startup.line);
    process.exit(1);
    return;
  }
  console.log(startup.line);
  useStorage(createStorage(startup.storage));

  await initDatabase();
  // Listening before the loop starts, so that a health port that is taken stops the process while it holds nothing: no
  // worker row, no claimed job (contracts/worker.md, "Start, in order").
  const health = await startHealthServer(startup.jobs.workerHealthPort);
  const worker = await startWorker({ db: kdb, llm: createLlm(startup.llm), llmConfig: startup.llm, concurrency: startup.jobs.workerConcurrency });

  let signals = 0;
  const shutdown = (signal: string): void => {
    signals++;
    if (signals > 1) {
      // A second signal exits at once. Its jobs come back when their leases run out.
      void worker.abandon().finally(() => process.exit(1));
      return;
    }
    console.log(`${signal} received, stopping`);
    // The health check keeps answering while the worker stops: the platform's stop signal is what drains it (Principle IV).
    void worker.stop().then(() => health.close()).then(() => db.end()).then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  // No error detail on purpose, as the server's catch-all: any property of the caught value could carry driver-attached
  // data derived from env-sourced config. A migration that stopped on purpose is the one exception: its message was
  // written for the operator.
  console.error(startupFailureLine('Startup failed', error));
  process.exit(1);
});
