import { MigrationRefusedError } from '@scrylux/db';
import { describe, expect, it } from 'vitest';
import { isRefusal, startupFailureLine } from '../src/startup-failure.js';

// What a process logs when it stops at start-up (Phase 3 Milestone 3, FR-091): a migration's refusal says what to do, and
// every other error says nothing about itself.

describe('startupFailureLine', () => {
  it('adds the message of a migration that stopped on purpose, which Scrylux wrote for an operator', () => {
    const refusal = new MigrationRefusedError('This database does not have the pgvector extension. See docs/install.md#upgrading-to-v02', 'SX001');
    expect(startupFailureLine('Startup failed', refusal)).toBe('Startup failed: This database does not have the pgvector extension. See docs/install.md#upgrading-to-v02');
    expect(startupFailureLine('Migration failed', refusal)).toMatch(/^Migration failed: /);
  });

  it('says nothing of any other error, which can carry a connection string or a query', () => {
    const driver = Object.assign(new Error('password authentication failed for user "postgres" at postgres://u:SECRET@db/threats'), { code: '28P01' });
    expect(startupFailureLine('Startup failed', driver)).toBe('Startup failed');
    expect(startupFailureLine('Startup failed', 'a string')).toBe('Startup failed');
    expect(startupFailureLine('Startup failed', undefined)).toBe('Startup failed');
    expect(startupFailureLine('Startup failed', Object.assign(new Error('SECRET'), { code: 'SX001' }))).toBe('Startup failed');
  });
});

describe('isRefusal', () => {
  it('is true for a refusal only, so that the wait for a starting database does not retry it', () => {
    expect(isRefusal(new MigrationRefusedError('m', 'SX002'))).toBe(true);
    expect(isRefusal(new Error('connection refused'))).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});
