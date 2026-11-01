import { MigrationRefusedError } from '@scrylux/db';

// The line a process logs when it stops at start-up. The error at the top of a start-up is caught blind on purpose: any
// property of it could carry driver text derived from the configuration (a connection string, a query). The one exception
// is a migration that stopped on purpose, whose message Scrylux wrote for an operator and which holds nothing else (Phase 3
// Milestone 3, FR-091, research #16).

/** `prefix`, with the refusal's message when the error is one, and nothing from any other error. */
export function startupFailureLine(prefix: string, error: unknown): string {
  return error instanceof MigrationRefusedError ? `${prefix}: ${error.message}` : prefix;
}

/** A migration refused for a reason an operator can fix is not worth retrying while the database starts. */
export const isRefusal = (error: unknown): boolean => error instanceof MigrationRefusedError;
