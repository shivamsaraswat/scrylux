import { z } from 'zod';
import { loadData, memoized, parseStrictYaml } from './data.js';
import type { OperationConfig, ProviderName } from './types.js';

// Prices (FR-033): the operator's own, or the shipped list in data/prices.yaml, or unknown. Unknown is a null cost and
// never a zero. The list is matched by exact model id, so a price is never applied to a model it was not checked for.

const money = z.number().min(0);
const tier = z.strictObject({ input: money, output: money.optional() });
const entrySchema = z.strictObject({
  model: z.string().min(1),
  input: money,
  /** Absent for an embedding model. */
  output: money.optional(),
  above_input_tokens: z.number().int().positive().optional(),
  above: tier.optional(),
  checked: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date written YYYY-MM-DD'),
  source: z.string().regex(/^https:\/\/\S+$/, 'must be an https address'),
});
export type PriceEntry = z.infer<typeof entrySchema>;

const fileSchema = z.strictObject({
  anthropic: z.array(entrySchema),
  'openai-compatible': z.array(entrySchema),
  bedrock: z.array(entrySchema),
  gemini: z.array(entrySchema),
});

export interface PriceList {
  entries: Record<ProviderName, PriceEntry[]>;
}

export function parsePriceFile(text: string): PriceList {
  const parsed = fileSchema.safeParse(parseStrictYaml('prices.yaml', text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`prices.yaml: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'is invalid'}`.replace('  ', ' '));
  }
  const today = new Date().toISOString().slice(0, 10);
  for (const [provider, entries] of Object.entries(parsed.data)) {
    const seen = new Set<string>();
    for (const entry of entries) {
      const where = `prices.yaml: ${provider} ${entry.model}`;
      if (seen.has(entry.model)) throw new Error(`${where} is listed more than once`);
      seen.add(entry.model);
      if (Number.isNaN(Date.parse(entry.checked))) throw new Error(`${where}: checked is not a date`);
      if (entry.checked > today) throw new Error(`${where}: checked is in the future`);
      if ((entry.above === undefined) !== (entry.above_input_tokens === undefined)) {
        throw new Error(`${where}: above_input_tokens and above go together`);
      }
      if (entry.above && (entry.above.output === undefined) !== (entry.output === undefined)) {
        throw new Error(`${where}: the higher tier needs an output price exactly when the entry has one`);
      }
    }
  }
  return { entries: parsed.data };
}

export const priceList = memoized(() => parsePriceFile(loadData('prices.yaml')));

export interface Price {
  input: number;
  /** Null for an embedding model. */
  output: number | null;
  /** The optional higher tier, chosen per attempt by that attempt's input tokens. */
  aboveInputTokens?: number;
  above?: { input: number; output: number | null };
  source: 'operator' | 'list';
}

type PricedOperation = Pick<OperationConfig, 'provider' | 'model' | 'baseUrl' | 'local' | 'operatorPrice'>;

// The list's OpenAI entries are OpenAI's prices. A deployment on Azure, a gateway, or a local server that happens to use
// the same model name has other prices, or none.
function listApplies(op: PricedOperation): boolean {
  if (op.provider !== 'openai-compatible') return true;
  if (op.local || op.baseUrl === null) return false;
  try {
    return new URL(op.baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

/** The operator's price when there is one, else the list's, else null (unknown). */
export function findPrice(op: PricedOperation): Price | null {
  if (op.operatorPrice !== null) return { input: op.operatorPrice.input, output: op.operatorPrice.output, source: 'operator' };
  if (!listApplies(op)) return null;
  const entry = priceList().entries[op.provider].find((e) => e.model === op.model);
  if (entry === undefined) return null;
  return {
    input: entry.input,
    output: entry.output ?? null,
    ...(entry.above_input_tokens === undefined || entry.above === undefined
      ? {}
      : { aboveInputTokens: entry.above_input_tokens, above: { input: entry.above.input, output: entry.above.output ?? null } }),
    source: 'list',
  };
}

export interface PricedCall {
  inputTokens: number;
  outputTokens: number;
}

/**
 * The cost in US dollars of every attempt, each priced in its own tier, rounded to 6 decimal places. Null when there
 * is no price: an unknown cost is never reported as zero.
 */
export function costOf(calls: readonly PricedCall[], price: Price | null): number | null {
  if (price === null) return null;
  let dollars = 0;
  for (const call of calls) {
    const rates = price.above !== undefined && price.aboveInputTokens !== undefined && call.inputTokens > price.aboveInputTokens ? price.above : price;
    dollars += (call.inputTokens * rates.input + call.outputTokens * (rates.output ?? 0)) / 1_000_000;
  }
  return Math.round(dollars * 1_000_000) / 1_000_000;
}
