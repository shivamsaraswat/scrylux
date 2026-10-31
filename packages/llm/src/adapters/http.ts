// Node's own fetch gives up on a request after about five minutes without response headers, whatever timeout an SDK is
// given: measured with a 900 second SDK timeout, the call failed at 301 seconds. A slow local model answers a
// non-streaming request only when it has finished, so LLM_TIMEOUT above five minutes would silently do nothing. The
// Anthropic, OpenAI and Gemini SDKs therefore get a fetch whose connection pool waits as long as LLM_TIMEOUT does
// (Bedrock's HTTP client has no such limit). The attempt loop's own signal, not this one, ends a call at the limit.

// Slack beyond the limit, so the loop's abort signal fires first and the category is decided there.
const MARGIN_MS = 5000;

export async function createFetch(timeoutMs: number): Promise<typeof globalThis.fetch> {
  const undici = await import('undici');
  const dispatcher = new undici.Agent({ headersTimeout: timeoutMs + MARGIN_MS, bodyTimeout: timeoutMs + MARGIN_MS });
  return ((input, init) => undici.fetch(input, { ...init, dispatcher })) as typeof globalThis.fetch;
}
