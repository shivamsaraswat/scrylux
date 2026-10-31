// Test-only entry point (@scrylux/llm/testing). It resolves under the @scrylux/source condition alone, sits outside
// src/ so it is never built, and is not in the package's `files`: nothing outside the source tree can import it.
// Production code never does.
import type { LoopDeps } from '../src/attempts.js';
import { createLlmInternal, type TestEndpoints } from '../src/client.js';
import type { Llm, LlmConfig } from '../src/types.js';

export type { TestEndpoints } from '../src/client.js';
export type { LoopDeps } from '../src/attempts.js';
export { resetCapabilityOverrides } from '../src/capabilities.js';

export { startStub, type RecordedRequest, type Scripted, type Stub } from './stubs/server.js';
export { anthropicError, anthropicMessage } from './stubs/anthropic.js';
export { bedrockError, converseAnswer, invokeAnswer } from './stubs/bedrock.js';
export { geminiAnswer, geminiEmbeddings, geminiError } from './stubs/gemini.js';
export { openaiCompletion, openaiEmbeddings, openaiError, plainError } from './stubs/openai.js';

/**
 * A client whose adapters send to stub servers. It does not run parseLlmConfig, so a test can set vendor variables in
 * process.env and show that the adapters ignore them. `deps` replaces the waits and the jitter of the retry loop, so a
 * test of a transient failure does not sleep.
 */
export function createLlmWithEndpoints(
  config: LlmConfig,
  options: { log?: (line: string) => void; endpoints: TestEndpoints; deps?: Partial<LoopDeps> },
): Llm {
  return createLlmInternal(config, options);
}
