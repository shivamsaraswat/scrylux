import { afterEach, describe, expect, it, vi } from 'vitest';

// Node's fetch gives up after about five minutes without response headers, whatever the SDK's timeout (measured: a
// 900 s SDK timeout failed at 301 s). createFetch must give the connection pool the same patience as LLM_TIMEOUT.

const agentOptions: unknown[] = [];
const fetchCalls: { init: { dispatcher?: unknown } }[] = [];

vi.mock('undici', () => ({
  Agent: class {
    constructor(options: unknown) {
      agentOptions.push(options);
    }
  },
  fetch: (_input: unknown, init: { dispatcher?: unknown }) => {
    fetchCalls.push({ init });
    return Promise.resolve(new Response('ok'));
  },
}));

afterEach(() => {
  agentOptions.length = 0;
  fetchCalls.length = 0;
});

describe('createFetch', () => {
  it('waits for headers and body as long as the time limit, plus a margin', async () => {
    const { createFetch } = await import('../src/adapters/http.js');
    await createFetch(900_000);
    expect(agentOptions).toEqual([{ headersTimeout: 905_000, bodyTimeout: 905_000 }]);
  });

  it('sends every request through that pool', async () => {
    const { createFetch } = await import('../src/adapters/http.js');
    const fetch = await createFetch(60_000);
    await fetch('https://example.invalid/x', { method: 'POST' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.init.dispatcher).toBeDefined();
  });
});
