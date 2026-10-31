import { z } from 'zod';
import { loadData, memoized, parseStrictYaml } from './data.js';
import type { AnswerMode } from './schema.js';
import type { ProviderName } from './types.js';

// What each model accepts, from data/models.yaml (FR-015a), plus a per-process memory of what a provider refused at run
// time. The memory only removes a free resend; nothing is persisted (Principle IV).

const PROVIDERS = ['anthropic', 'openai-compatible', 'bedrock', 'gemini'] as const satisfies readonly ProviderName[];

const entrySchema = z.strictObject({
  match: z.string().min(1),
  temperature: z.enum(['send', 'omit']).optional(),
  reason: z.string().min(1).optional(),
  source: z.string().regex(/^https:\/\/\S+$/, 'must be an https address').optional(),
  structured_output: z.enum(['native', 'instructions']).optional(),
  max_tokens_param: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  embedding_batch: z.number().int().min(1).max(2048).optional(),
  embedding_body: z.literal('titan-v2').optional(),
});
export type ModelEntry = z.infer<typeof entrySchema>;

const fileSchema = z.strictObject({
  anthropic: z.array(entrySchema).min(1),
  'openai-compatible': z.array(entrySchema).min(1),
  bedrock: z.array(entrySchema).min(1),
  gemini: z.array(entrySchema).min(1),
});

export interface ModelsFile {
  entries: Record<ProviderName, ModelEntry[]>;
}

export interface Capability {
  temperature: 'send' | 'omit';
  structuredOutput: AnswerMode;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  embeddingBatch: number;
  embeddingBody: 'titan-v2' | null;
}

// Which fields mean something for which provider. A field set where it does not apply is a mistake in the file.
const APPLIES: Record<keyof Omit<ModelEntry, 'match' | 'reason' | 'source'>, readonly ProviderName[]> = {
  temperature: PROVIDERS,
  structured_output: PROVIDERS,
  max_tokens_param: ['openai-compatible'],
  embedding_batch: ['openai-compatible', 'bedrock', 'gemini'],
  embedding_body: ['bedrock'],
};
// The "*" entry must set these for its provider. embedding_body is optional everywhere.
const REQUIRED_ON_DEFAULT = ['temperature', 'structured_output', 'max_tokens_param', 'embedding_batch'] as const;

export function parseModelsFile(text: string): ModelsFile {
  const parsed = fileSchema.safeParse(parseStrictYaml('models.yaml', text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`models.yaml: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'is invalid'}`.replace('  ', ' '));
  }
  const entries = parsed.data as Record<ProviderName, ModelEntry[]>;

  for (const provider of PROVIDERS) {
    const list = entries[provider];
    const last = list[list.length - 1];
    if (last?.match !== '*') throw new Error(`models.yaml: ${provider}: the last entry must match "*"`);
    for (const entry of list) {
      for (const [field, providers] of Object.entries(APPLIES)) {
        if (field in entry && !providers.includes(provider)) {
          throw new Error(`models.yaml: ${provider} "${entry.match}": ${field} does not apply to ${provider}`);
        }
      }
      if (entry.temperature === 'omit' && (entry.reason === undefined || entry.source === undefined)) {
        throw new Error(`models.yaml: ${provider} "${entry.match}": temperature: omit needs a reason and an https source`);
      }
    }
    for (const field of REQUIRED_ON_DEFAULT) {
      if (APPLIES[field].includes(provider) && last[field] === undefined) {
        throw new Error(`models.yaml: ${provider}: the "*" entry must set ${field}`);
      }
    }
  }
  return { entries };
}

const globs = new Map<string, RegExp>();
function matches(glob: string, model: string): boolean {
  let re = globs.get(glob);
  if (re === undefined) {
    re = new RegExp(`^${glob.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    globs.set(glob, re);
  }
  return re.test(model);
}

/** The file's answer for a model, with no run-time memory applied. */
export function lookupCapability(file: ModelsFile, provider: ProviderName, model: string): Capability {
  const list = file.entries[provider];
  const entry = list.find((e) => matches(e.match, model));
  const base = list[list.length - 1] as ModelEntry;
  return {
    temperature: entry?.temperature ?? base.temperature ?? 'send',
    structuredOutput: entry?.structured_output ?? base.structured_output ?? 'native',
    maxTokensParam: entry?.max_tokens_param ?? base.max_tokens_param ?? 'max_tokens',
    embeddingBatch: entry?.embedding_batch ?? base.embedding_batch ?? 1,
    embeddingBody: entry?.embedding_body ?? base.embedding_body ?? null,
  };
}

const shipped = memoized(() => parseModelsFile(loadData('models.yaml')));

// ---- What a provider refused at run time ---------------------------------------------------------------------------

interface Override {
  temperature?: 'omit';
  structuredOutput?: AnswerMode;
  maxTokensParam?: 'max_completion_tokens';
}
const overrides = new Map<string, Override>();
const keyOf = (provider: ProviderName, model: string): string => `${provider}\u0000${model}`;

/** The next, weaker way of asking for JSON, or undefined when the model is already at the weakest. */
export function nextFormatMode(provider: ProviderName, mode: AnswerMode): AnswerMode | undefined {
  if (mode === 'native') return provider === 'openai-compatible' ? 'json_object' : 'instructions';
  if (mode === 'json_object') return 'instructions';
  return undefined;
}

export function resolveCapability(provider: ProviderName, model: string): Capability {
  const capability = lookupCapability(shipped(), provider, model);
  const override = overrides.get(keyOf(provider, model));
  if (override?.temperature) capability.temperature = override.temperature;
  if (override?.structuredOutput) capability.structuredOutput = override.structuredOutput;
  if (override?.maxTokensParam) capability.maxTokensParam = override.maxTokensParam;
  return capability;
}

/** Remembers, for this process only, that a provider refused a setting for a model, so the next request skips the resend. */
export function rememberRefusal(provider: ProviderName, model: string, setting: 'temperature' | 'format' | 'max_tokens'): void {
  const key = keyOf(provider, model);
  const override = overrides.get(key) ?? {};
  if (setting === 'temperature') override.temperature = 'omit';
  else if (setting === 'max_tokens') override.maxTokensParam = 'max_completion_tokens';
  else {
    const next = nextFormatMode(provider, resolveCapability(provider, model).structuredOutput);
    if (next !== undefined) override.structuredOutput = next;
  }
  overrides.set(key, override);
}

/** For tests only: exported through @scrylux/llm/testing, not through the package's index. */
export function resetCapabilityOverrides(): void {
  overrides.clear();
}
