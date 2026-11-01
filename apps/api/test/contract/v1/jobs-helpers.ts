import { randomUUID } from 'node:crypto';
import { login } from '../helpers.js';
import { accountIdOf } from './helpers.js';

// For the job route tests (Phase 3 Milestone 2). Not a test file: the jobs group runs the files that match jobs*.test.ts one
// at a time, and each starts from empty job tables.

/** A new account, signed in: the token and the id it was issued for. */
export async function createAccount(baseUrl: string, adminToken: string): Promise<{ token: string; id: number }> {
  const username = `jobs-test-${randomUUID()}`.slice(0, 40);
  const password = `pw-${randomUUID()}`.slice(0, 40);
  const res = await fetch(`${baseUrl}/api/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 201) throw new Error(`could not create an account: ${res.status}`);
  const token = await login(baseUrl, username, password);
  return { token, id: accountIdOf(token) };
}

/** An AI provider served at a made-up local address: enough for the API to report it, which is all the API does. */
export const LOCAL_PROVIDER = {
  LLM_PROVIDER: 'openai-compatible',
  LLM_MODEL: 'llama3.2',
  LLM_BASE_URL: 'http://127.0.0.1:9/v1',
  LLM_LOCAL: 'true',
} as const;
