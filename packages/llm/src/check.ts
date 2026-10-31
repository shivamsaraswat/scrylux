import { z } from 'zod';
import { loadPrompt, memoized, parseStrictYaml } from './data.js';

// The fixed request of the operator's check (FR-046, FR-047), read from prompts/check.yaml like any other prompt.

const fileSchema = z.strictObject({
  generation: z.strictObject({
    instructions: z.string().min(1),
    field: z.string().regex(/^[a-z][a-z_]*$/),
    schema_name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  }),
  embedding: z.strictObject({ text: z.string().min(1) }),
});

export interface CheckRequest {
  generation: { instructions: string; schemaName: string; schema: z.ZodType<Record<string, string>> };
  embedding: { text: string };
}

const load = memoized((): CheckRequest => {
  const file = fileSchema.parse(parseStrictYaml('check.yaml', loadPrompt('check.yaml')));
  return {
    generation: {
      instructions: file.generation.instructions,
      schemaName: file.generation.schema_name,
      schema: z.strictObject({ [file.generation.field]: z.string().min(1) }),
    },
    embedding: { text: file.embedding.text },
  };
});

/** What the check sends to generation and to embeddings. */
export function checkRequest(): CheckRequest {
  return load();
}
