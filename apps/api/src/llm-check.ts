import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkRequest, createLlm, FAILURE_MESSAGES, LlmConfigError, parseLlmConfig,
  type FailureCategory, type Llm, type LlmConfig, type OperationConfig, type Usage,
} from '@scrylux/llm';
import config from './config.js';
import { llmEnvironment, type AiKeys } from './llm-startup.js';

// The operator's check (Phase 3 Milestone 1, US6): one tiny fixed request, with no user data, to each configured
// operation, and a plain report of what happened. Run it where Scrylux is deployed, in the image or from source:
//   docker compose exec app node dist/llm-check.js        pnpm --filter @scrylux/api llm:check
// The report goes to stdout. The layer's own log lines go to stderr, so the report can be read or piped on its own.
// It never touches the database, and it never prints a key, a base address, a provider's error or a model's answer.
// Exit status: 0 every configured operation worked (or none is configured), 1 one failed, 2 the configuration is invalid.

export interface CheckOptions {
  env: NodeJS.ProcessEnv;
  /** The AI keys that config.load() resolved: the environment's, overridden by the secrets-manager secret. */
  keys: AiKeys;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** Tests give the client that talks to stub servers. */
  createLlm?: (config: LlmConfig, options: { log?: (line: string) => void }) => Llm;
}

type Prefix = 'LLM' | 'EMBEDDING';

// One fixed hint per category, naming the setting to look at (FR-046).
function hint(category: FailureCategory, prefix: Prefix): string {
  switch (category) {
    case 'not_authorized':
      return `Check ${prefix}_API_KEY, and that the key may use this model. For Bedrock, check the role’s permissions.`;
    case 'not_available':
      return `Check ${prefix}_MODEL. For Ollama, run \`ollama pull <model>\` first. For Bedrock, check that the model is enabled in ${prefix}_REGION.`;
    case 'rate_limited':
      return `The provider is limiting requests. Wait and run the check again, or look at the limits of the account behind ${prefix}_API_KEY, or choose another ${prefix}_MODEL.`;
    case 'provider_unavailable':
      return `Check that the provider is up and reachable from here (${prefix}_BASE_URL or ${prefix}_REGION). A slow local model may need a larger LLM_TIMEOUT.`;
    case 'input_too_large':
      return 'The check sends only a few words, so the model’s context length is set too low. For Ollama, raise OLLAMA_CONTEXT_LENGTH.';
    case 'output_limit_reached':
      return `The model used up its output limit before it answered. Check ${prefix}_MODEL: a model that reasons at length may need another.`;
    case 'refused':
      return `The model declined a harmless request. Try another model: ${prefix}_MODEL.`;
    case 'rejected':
      return `Check that ${prefix}_MODEL names a model that can do this, and that the provider accepts what Scrylux sends it.`;
    case 'invalid_output':
      return `The model did not answer in the required shape. A small model may fail this, so try a larger one: ${prefix}_MODEL.`;
    case 'not_configured':
    case 'cancelled':
      return `Check ${prefix}_PROVIDER.`;
  }
}

function describeOperation(label: string, op: OperationConfig, prefix: Prefix): string {
  const where = op.hosted ? 'hosted (data sent to it leaves this install)' : `local (declared with ${prefix}_LOCAL=true)`;
  return `${label}: ${op.provider}, model ${op.model}, ${where}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeCost(usage: Usage): string {
  if (usage.costUsd === null) return 'cost unknown (no price set)';
  const source = usage.priceSource === 'operator' ? 'operator price' : 'price list';
  return `cost $${usage.costUsd.toFixed(6)} (${source}${usage.costEstimated ? ', from estimated tokens' : ''})`;
}

const estimated = (usage: Usage): string => (usage.tokensEstimated ? ' (estimated)' : '');

// "64 input + 9 output tokens" for generation, "9 input tokens" for embeddings, with "(estimated)" where they were.
const tokenCounts = (usage: Usage, withOutput: boolean): string =>
  withOutput ? `${usage.inputTokens} input + ${usage.outputTokens} output tokens${estimated(usage)}` : `${usage.inputTokens} input tokens${estimated(usage)}`;

export async function runCheck(options: CheckOptions): Promise<0 | 1 | 2> {
  const { stdout, stderr } = options;
  let llmConfig: LlmConfig;
  try {
    llmConfig = parseLlmConfig(llmEnvironment(options.env, options.keys));
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    stdout.write(`Invalid AI provider configuration: ${error.message}\n`);
    return 2;
  }
  if (llmConfig.generation === null && llmConfig.embedding === null) {
    stdout.write('No AI provider is configured. Scrylux runs without AI features. See docs/ai-providers.md.\n');
    return 0;
  }

  const llm = (options.createLlm ?? createLlm)(llmConfig, { log: (line) => void stderr.write(`${line}\n`) });
  const fixed = checkRequest();
  let failed = false;
  let first = true;

  // Each block starts as soon as its request does, so a slow model is not met with silence.
  const begin = (header: string): void => {
    stdout.write(`${first ? '' : '\n'}${header}\n`);
    first = false;
  };
  // A failed request can still have used tokens (an answer in the wrong shape, asked for three times), so the report says
  // what it used (FR-046). A request that was never sent used nothing, and says nothing.
  const fail = (category: FailureCategory, prefix: Prefix, usage: Usage, outputTokens: boolean): void => {
    failed = true;
    stdout.write(`  FAILED: ${category.replace(/_/g, ' ')}. ${FAILURE_MESSAGES[category]}\n  ${hint(category, prefix)}\n`);
    if (usage.attempts > 0) stdout.write(`  Used: ${plural(usage.attempts, 'attempt')}, ${tokenCounts(usage, outputTokens)}, ${describeCost(usage)}\n`);
  };

  if (llmConfig.generation !== null) {
    begin(describeOperation('Generation', llmConfig.generation, 'LLM'));
    const result = await llm.generate({
      schema: fixed.generation.schema,
      schemaName: fixed.generation.schemaName,
      instructions: fixed.generation.instructions,
    });
    if (result.ok) {
      const u = result.usage;
      stdout.write(`  OK in ${(u.durationMs / 1000).toFixed(1)} s, ${plural(u.attempts, 'attempt')}, ${tokenCounts(u, true)}, ${describeCost(u)}\n`);
    } else fail(result.failure.category, 'LLM', result.usage, true);
  }

  if (llmConfig.embedding !== null) {
    begin(describeOperation('Embeddings', llmConfig.embedding, 'EMBEDDING'));
    const result = await llm.embed({ texts: [fixed.embedding.text] });
    if (result.ok) {
      const u = result.usage;
      stdout.write(`  OK in ${(u.durationMs / 1000).toFixed(1)} s, dimension ${result.dimension}, ${tokenCounts(u, false)}, ${describeCost(u)}\n`);
    } else fail(result.failure.category, 'EMBEDDING', result.usage, false);
  }

  return failed ? 1 : 0;
}

async function main(): Promise<void> {
  try {
    await config.load();
  } catch {
    // A fixed line, like the server's: the error may carry the secret's id or the provider's text.
    process.stdout.write('Could not read the secrets-manager secret named by DB_SECRET_ID.\n');
    process.exitCode = 2;
    return;
  }
  process.exitCode = await runCheck({ env: process.env, keys: config, stdout: process.stdout, stderr: process.stderr });
}

// Runs only when this file is the program, not when a test imports runCheck.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(() => {
    process.stdout.write('The check failed unexpectedly.\n');
    process.exitCode = 2;
  });
}
