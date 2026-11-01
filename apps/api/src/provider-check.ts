import { checkRequest, requestSize, type FailureCategory, type Llm, type LlmConfig, type OperationConfig, type Usage } from '@scrylux/llm';

// The provider check (Phase 3 Milestone 1's operator command, Milestone 2's job): one tiny fixed request, with no user
// data, to each configured operation. The command and the job both run it, so the two cannot drift (research #8). The
// request is kept as versioned data in the llm package (prompts/check.yaml, FR-047, FR-093): nothing a person typed
// reaches it.

export type CheckOperation = 'generation' | 'embeddings';
const OPERATIONS: readonly CheckOperation[] = ['generation', 'embeddings'];

/** `not_run` is an operation the check never reached because it was stopped or cancelled first. */
export type CheckStatus = 'ok' | 'not_configured' | 'not_run' | FailureCategory;

export interface CheckResult {
  operation: CheckOperation;
  status: CheckStatus;
  /** Null when the operation is not configured. It holds the key and the address: never log or return it. */
  config: OperationConfig | null;
  /** Null when no request was made. */
  usage: Usage | null;
  /** Embeddings that worked: the length of the vectors. */
  dimension: number | null;
}

export interface CheckHooks {
  /** Stops the check: an operation not yet tried is reported as not_run. */
  signal?: AbortSignal;
  /** Called before an operation is tried: the job's progress, and the command's header. */
  onStart?: (operation: CheckOperation, config: OperationConfig) => void | Promise<void>;
  /**
   * Awaited before each request is sent, with the size of what it will send. It may throw to stop the check: the error
   * reaches the caller, which has every earlier result from `onResult` (the job's gate and its caps).
   */
  beforeRequest?: (request: { operation: 'generate' | 'embed'; inputChars: number }) => void | Promise<void>;
  /** Called with each operation's result as soon as it ends, not-configured and not-run ones included. */
  onResult?: (result: CheckResult) => void | Promise<void>;
}

const none = (operation: CheckOperation, status: CheckStatus, config: OperationConfig | null): CheckResult => ({
  operation,
  status,
  config,
  usage: null,
  dimension: null,
});

/** Runs the check against each configured operation in turn, generation first, and returns every result. */
export async function runProviderCheck(llm: Llm, config: LlmConfig, hooks: CheckHooks = {}): Promise<CheckResult[]> {
  const fixed = checkRequest();
  const signal = hooks.signal === undefined ? {} : { signal: hooks.signal };
  const results: CheckResult[] = [];

  for (const operation of OPERATIONS) {
    const op = operation === 'generation' ? config.generation : config.embedding;
    let result: CheckResult;
    if (op === null) {
      result = none(operation, 'not_configured', null);
    } else if (hooks.signal?.aborted) {
      result = none(operation, 'not_run', op);
    } else {
      await hooks.onStart?.(operation, op);
      if (operation === 'generation') {
        const request = { schema: fixed.generation.schema, schemaName: fixed.generation.schemaName, instructions: fixed.generation.instructions };
        await hooks.beforeRequest?.({ operation: 'generate', inputChars: requestSize(request) });
        const answer = await llm.generate({ ...request, ...signal });
        result = answer.ok
          ? { operation, status: 'ok', config: op, usage: answer.usage, dimension: null }
          : { operation, status: answer.failure.category, config: op, usage: answer.usage, dimension: null };
      } else {
        const request = { texts: [fixed.embedding.text] };
        await hooks.beforeRequest?.({ operation: 'embed', inputChars: requestSize(request) });
        const answer = await llm.embed({ ...request, ...signal });
        result = answer.ok
          ? { operation, status: 'ok', config: op, usage: answer.usage, dimension: answer.dimension }
          : { operation, status: answer.failure.category, config: op, usage: answer.usage, dimension: null };
      }
    }
    results.push(result);
    await hooks.onResult?.(result);
  }
  return results;
}

/** Whether the check as a whole worked: every configured operation did. An operation that is not configured does not fail it. */
export const checkSucceeded = (results: readonly CheckResult[]): boolean =>
  results.every((r) => r.status === 'ok' || r.status === 'not_configured');
