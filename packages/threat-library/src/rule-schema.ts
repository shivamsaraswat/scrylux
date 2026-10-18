import {
  DESCRIPTION_MAX_LENGTH,
  ELEMENT_FLAGS,
  IMPACTS,
  LIKELIHOODS,
  NAME_MAX_LENGTH,
  STRIDE_CATEGORIES,
  URL_MAX_LENGTH,
} from '@scrylux/core';
import { z } from 'zod';
import {
  NODE_TYPES,
  RULE_ELEMENT_TYPES,
  STRIDE_PER_ELEMENT,
  type RuleElementType,
} from './stride.js';

// The shape of the three kinds of data file, with the limits of data-model.md. Text is trimmed and
// counted in code points, as @scrylux/core counts it (and as Postgres' char_length does).

const ID_MAX_LENGTH = 100;
const MITIGATIONS_MAX = 5;
const REFERENCES_MAX = 10;
const REASON_MAX_LENGTH = 200;
const REPLACEMENTS_MAX = 10;

const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const codePoints = (value: string): number => [...value].length;

const id = z
  .string()
  .max(ID_MAX_LENGTH, `must be at most ${ID_MAX_LENGTH} characters`)
  .regex(ID_PATTERN, 'must be lowercase letters, digits and single hyphens');

function text(max: number) {
  return z
    .string()
    .trim()
    .min(1, 'must not be empty')
    .refine((value) => codePoints(value) <= max, { message: `must be at most ${max} characters` });
}

const yesNo = z.enum(['yes', 'no'], { error: () => 'write yes or no' });
const exampleState = z.enum(['yes', 'no', 'not_assessed'], {
  error: () => 'write yes, no or not_assessed',
});
const nodeType = z.enum(NODE_TYPES, { error: () => `must be one of ${NODE_TYPES.join(', ')}` });

const CWE = /^CWE-[1-9][0-9]*$/;
const CAPEC = /^CAPEC-[1-9][0-9]*$/;
const httpsUrl = z.url({ protocol: /^https$/ });

const reference = z.string().superRefine((value, ctx) => {
  if (CWE.test(value) || CAPEC.test(value)) return;
  const isUrl =
    httpsUrl.safeParse(value).success && !/\s/.test(value) && codePoints(value) <= URL_MAX_LENGTH;
  if (!isUrl) {
    ctx.addIssue({
      code: 'custom',
      message: `must be CWE-<number>, CAPEC-<number> or an https link of at most ${URL_MAX_LENGTH} characters`,
    });
  }
});

const flowConditions = z.strictObject({
  crosses_trust_boundary: yesNo.optional(),
  source_type: nodeType.optional(),
  target_type: nodeType.optional(),
});

const conditions = z.strictObject({
  flags: z.record(z.string(), yesNo).optional(),
  flow: flowConditions.optional(),
});

const exampleFlow = z.strictObject({
  crosses_trust_boundary: yesNo,
  source_type: nodeType,
  target_type: nodeType,
});
const example = z.strictObject({
  flags: z.record(z.string(), exampleState).optional(),
  flow: exampleFlow.optional(),
});

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const HAS_PLACEHOLDER = /\{\{[^{}]*\}\}/;

function placeholdersAllowedFor(type: RuleElementType): readonly string[] {
  return type === 'data_flow' ? ['element', 'source', 'target'] : ['element'];
}

const RuleBase = z.strictObject({
  id,
  element_type: z.enum(RULE_ELEMENT_TYPES, {
    error: () => `must be one of ${RULE_ELEMENT_TYPES.join(', ')}`,
  }),
  category: z.enum(STRIDE_CATEGORIES),
  title: text(NAME_MAX_LENGTH),
  description: text(DESCRIPTION_MAX_LENGTH),
  likelihood: z.enum(LIKELIHOODS),
  impact: z.enum(IMPACTS),
  variant_group: id.optional(),
  when: conditions.optional(),
  mitigations: z
    .array(text(DESCRIPTION_MAX_LENGTH))
    .min(1, 'suggest at least one mitigation')
    .max(MITIGATIONS_MAX, `at most ${MITIGATIONS_MAX} mitigations`)
    .refine((items) => new Set(items.map((item) => item.toLowerCase())).size === items.length, {
      message: 'mitigations must be different from each other, ignoring case',
    }),
  references: z
    .array(reference)
    .max(REFERENCES_MAX, `at most ${REFERENCES_MAX} references`)
    .refine((items) => new Set(items).size === items.length, {
      message: 'references must be different from each other',
    })
    .optional(),
  examples: z.strictObject({
    applies: z.array(example).min(1, 'give at least one element the rule applies to'),
    does_not_apply: z.array(example).optional(),
  }),
});

export type Condition = 'yes' | 'no';
export type ExampleState = 'yes' | 'no' | 'not_assessed';

export interface RuleExample {
  flags: Record<string, ExampleState>;
  flow?: {
    crosses_trust_boundary: Condition;
    source_type: (typeof NODE_TYPES)[number];
    target_type: (typeof NODE_TYPES)[number];
  };
}

export interface Rule {
  readonly id: string;
  readonly element_type: RuleElementType;
  readonly category: (typeof STRIDE_CATEGORIES)[number];
  readonly title: string;
  readonly description: string;
  readonly likelihood: (typeof LIKELIHOODS)[number];
  readonly impact: (typeof IMPACTS)[number];
  readonly variant_group: string | null;
  readonly when: {
    readonly flags: Readonly<Record<string, Condition>>;
    readonly flow: {
      readonly crosses_trust_boundary?: Condition;
      readonly source_type?: (typeof NODE_TYPES)[number];
      readonly target_type?: (typeof NODE_TYPES)[number];
    };
  };
  readonly mitigations: readonly string[];
  readonly references: readonly string[];
  readonly examples: {
    readonly applies: readonly RuleExample[];
    readonly does_not_apply: readonly RuleExample[];
  };
}

function checkFlags(
  type: RuleElementType,
  flags: Record<string, unknown> | undefined,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const allowed: readonly string[] = ELEMENT_FLAGS[type];
  const all: ReadonlySet<string> = new Set(Object.values(ELEMENT_FLAGS).flat());
  for (const flag of Object.keys(flags ?? {})) {
    if (allowed.includes(flag)) continue;
    ctx.addIssue({
      code: 'custom',
      path: [...path, flag],
      message: all.has(flag) ? `flag does not apply to ${type}` : 'unknown flag',
    });
  }
}

function checkPlaceholders(
  type: RuleElementType,
  value: string,
  field: string,
  ctx: z.RefinementCtx,
): void {
  const allowed = placeholdersAllowedFor(type);
  for (const match of value.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    if (!allowed.includes(name)) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `unknown placeholder {{${name}}}; ${type === 'data_flow' ? 'use {{element}}, {{source}} or {{target}}' : 'use {{element}}'}`,
      });
    }
  }
}

export const RuleFileSchema = RuleBase.superRefine((rule, ctx) => {
  const type = rule.element_type;
  if (!STRIDE_PER_ELEMENT[type].includes(rule.category)) {
    ctx.addIssue({
      code: 'custom',
      path: ['category'],
      message: `${rule.category} is not a STRIDE-per-element category for ${type} (allowed: ${STRIDE_PER_ELEMENT[type].join(', ')})`,
    });
  }
  checkFlags(type, rule.when?.flags, ['when', 'flags'], ctx);
  if (rule.when?.flow && type !== 'data_flow') {
    ctx.addIssue({
      code: 'custom',
      path: ['when', 'flow'],
      message: 'only data-flow rules can have flow conditions',
    });
  }
  checkPlaceholders(type, rule.title, 'title', ctx);
  checkPlaceholders(type, rule.description, 'description', ctx);
  // Mitigations are copied as written, so a placeholder would reach the user as raw braces.
  rule.mitigations.forEach((mitigation, index) => {
    if (HAS_PLACEHOLDER.test(mitigation)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mitigations', index],
        message:
          'placeholders belong in the title and description; a mitigation is copied as written',
      });
    }
  });

  const lists = [
    ['applies', rule.examples.applies],
    ['does_not_apply', rule.examples.does_not_apply ?? []],
  ] as const;
  for (const [name, items] of lists) {
    items.forEach((item, index) => {
      checkFlags(type, item.flags, ['examples', name, index, 'flags'], ctx);
      if (type === 'data_flow' && !item.flow) {
        ctx.addIssue({
          code: 'custom',
          path: ['examples', name, index],
          message: 'a data-flow example needs a flow',
        });
      }
      if (type !== 'data_flow' && item.flow) {
        ctx.addIssue({
          code: 'custom',
          path: ['examples', name, index, 'flow'],
          message: 'only data-flow examples have a flow',
        });
      }
    });
  }

  const hasConditions =
    Object.keys(rule.when?.flags ?? {}).length > 0 || Object.keys(rule.when?.flow ?? {}).length > 0;
  if (hasConditions && (rule.examples.does_not_apply ?? []).length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['examples', 'does_not_apply'],
      message: 'required when the rule has conditions: give an element it does not apply to',
    });
  }
}).transform((rule): Rule => ({
  id: rule.id,
  element_type: rule.element_type,
  category: rule.category,
  title: rule.title,
  description: rule.description,
  likelihood: rule.likelihood,
  impact: rule.impact,
  variant_group: rule.variant_group ?? null,
  when: { flags: rule.when?.flags ?? {}, flow: rule.when?.flow ?? {} },
  mitigations: rule.mitigations,
  references: rule.references ?? [],
  examples: {
    applies: rule.examples.applies.map(normaliseExample),
    does_not_apply: (rule.examples.does_not_apply ?? []).map(normaliseExample),
  },
}));

function normaliseExample(item: z.infer<typeof example>): RuleExample {
  return item.flow ? { flags: item.flags ?? {}, flow: item.flow } : { flags: item.flags ?? {} };
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])] as [
    number,
    number,
    number,
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export interface RetirementRecord {
  readonly id: string;
  readonly retired_on: string;
  readonly reason: string;
  readonly replaced_by: readonly string[];
}

const retirementRecord = z.strictObject({
  id,
  retired_on: z.string().refine(isRealDate, { message: 'must be a real date written YYYY-MM-DD' }),
  reason: text(REASON_MAX_LENGTH),
  replaced_by: z
    .array(id)
    .max(REPLACEMENTS_MAX, `at most ${REPLACEMENTS_MAX} replacements`)
    .optional(),
});

export const RetiredFileSchema = z
  .strictObject({ retired: z.array(retirementRecord) })
  .transform((file): RetirementRecord[] =>
    file.retired.map((record) => ({ ...record, replaced_by: record.replaced_by ?? [] })),
  );

// Entries are listed once, in code-unit order, so two pull requests adding different ids rarely
// touch the same line (research #8).
export const RegistryFileSchema = z
  .strictObject({
    ids: z.array(id).superRefine((entries, ctx) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry)) {
          ctx.addIssue({ code: 'custom', path: [index], message: 'listed twice' });
        } else if (index > 0 && entry < (entries[index - 1] as string)) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message: `out of order: it sorts before "${entries[index - 1]}", so list it before that entry`,
          });
        }
        seen.add(entry);
      });
    }),
  })
  .transform((file): string[] => file.ids);
