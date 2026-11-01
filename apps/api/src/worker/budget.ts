import type { WorstCase } from '@scrylux/llm';
import type { GateResult } from '../jobs/store.js';

// The caps of a job (Phase 3 Milestone 2, FR-040 to FR-045). Before each model request the job asks whether the most that
// request could use still fits under what is left of its token cap and its cost cap, counting every earlier run. If it
// does not, the request is not sent: a cap is a ceiling, not an alarm. The arithmetic of the worst case is the provider
// layer's (worstCase); this decides.

export interface Caps {
  tokens: number;
  costUsd: number;
}

export type Verdict =
  /** The request fits. */
  | { ok: true }
  /** It does not. `detail` is set when the cap is lower than the most one request could use, so no request ever fits (FR-044). */
  | { ok: false; detail?: 'cap_below_one_request' };

/**
 * `used` is what the gate read: tokens over every request the job made, and the costs that were known. The token cap
 * always applies. The cost cap applies to a request whose price is known (FR-043): it is checked against the cost so far
 * that is known, which is the least the job has cost. A request whose price is unknown has no worst-case cost, and only the
 * token cap holds it.
 */
export function checkBudget(used: Extract<GateResult, { status: 'ok' }>, caps: Caps, worst: WorstCase): Verdict {
  if (worst.tokens > caps.tokens || (worst.costUsd !== null && worst.costUsd > caps.costUsd)) {
    return { ok: false, detail: 'cap_below_one_request' };
  }
  if (used.usedTokens + worst.tokens > caps.tokens) return { ok: false };
  if (worst.costUsd !== null && used.usedCostUsd + worst.costUsd > caps.costUsd) return { ok: false };
  return { ok: true };
}
