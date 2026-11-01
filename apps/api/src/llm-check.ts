import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLlm, FAILURE_MESSAGES, LlmConfigError, parseLlmConfig, type FailureCategory, type Llm, type LlmConfig, type OperationConfig, type Usage } from '@scrylux/llm';
import config from './config.js';
import { providerHint } from './jobs/failures.js';
import { llmEnvironment, type AiKeys } from './llm-startup.js';
import { checkSucceeded, runProviderCheck, type CheckResult } from './provider-check.js';

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
  let first = true;

  // Each block starts as soon as its request does, so a slow model is not met with silence.
  const begin = (header: string): void => {
    stdout.write(`${first ? '' : '\n'}${header}\n`);
    first = false;
  };
  // A failed request can still have used tokens (an answer in the wrong shape, asked for three times), so the report says
  // what it used (FR-046). A request that was never sent used nothing, and says nothing.
  const report = (result: CheckResult): void => {
    if (result.status === 'not_configured' || result.usage === null) return;
    const generation = result.operation === 'generation';
    const u = result.usage;
    if (result.status === 'ok') {
      const shape = generation ? `${plural(u.attempts, 'attempt')}, ${tokenCounts(u, true)}` : `dimension ${result.dimension}, ${tokenCounts(u, false)}`;
      stdout.write(`  OK in ${(u.durationMs / 1000).toFixed(1)} s, ${shape}, ${describeCost(u)}\n`);
      return;
    }
    const category = result.status as FailureCategory;
    stdout.write(`  FAILED: ${category.replace(/_/g, ' ')}. ${FAILURE_MESSAGES[category]}\n  ${providerHint(category, generation ? 'LLM' : 'EMBEDDING')}\n`);
    if (u.attempts > 0) stdout.write(`  Used: ${plural(u.attempts, 'attempt')}, ${tokenCounts(u, generation)}, ${describeCost(u)}\n`);
  };

  const results = await runProviderCheck(llm, llmConfig, {
    onStart: (operation, op) => begin(operation === 'generation' ? describeOperation('Generation', op, 'LLM') : describeOperation('Embeddings', op, 'EMBEDDING')),
    onResult: report,
  });
  return checkSucceeded(results) ? 0 : 1;
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
