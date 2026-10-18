import pg from 'pg';

// The database dedicated to this package's tests. global-setup.ts drops and recreates it on every
// run, so edits to unmerged migration files are always re-applied (research.md #14).
export const TEST_DB = 'scrylux_db_test';

// SQL identifiers (table, column and database names) cannot be query parameters. Wherever one is
// built into a statement it is a constant, checked against a fixed list or strict pattern, and always
// passed through here; values are always $n parameters (constitution Principle I).
export const escapeIdentifier = (name: string): string => pg.escapeIdentifier(name);

export function connectionSettings(database: string): pg.PoolConfig {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database,
  };
}
