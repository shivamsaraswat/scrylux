import { fileURLToPath } from 'node:url';
import { migrate as runMigrations } from '@scrylux/db';
import db from './db.js';
import config from './config.js';
import { startupFailureLine } from './startup-failure.js';

export default async function migrate(): Promise<void> {
  await runMigrations(db);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  config
    .load()
    .then(migrate)
    .then(() => db.end())
    .catch((error: unknown) => {
      // No error detail logged here on purpose: config.load() and migrate() failures
      // may carry driver-attached data derived from env-sourced config (connection
      // string, query text) on any property of the caught value. A migration that stopped
      // on purpose is the one exception: its message was written for the operator.
      console.error(startupFailureLine('Migration failed', error));
      process.exit(1);
    });
}
