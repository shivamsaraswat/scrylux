import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ScryluxFileV1, toJsonSchemaOverride } from '@scrylux/core';
import { z } from 'zod';

// The published schema of the Scrylux file, format version 1 (FR-003a), generated from the same zod schema the import
// parses with, so a file the schema accepts passes the import's field rules and one it rejects is refused by it. It
// states structure and limits per field. What a schema cannot say (the flags allowed per element type, references
// between records, nesting without cycles, the element limit, a reason only on accepted or not applicable threats, a
// stale mark only on generated threats, one generated threat per element and rule) is checked by the import, and listed
// in docs/formats/scrylux-file.md.
//
// `io: 'input'` because the element schema carries a transform (its per-type rules), and JSON Schema can only describe
// what a client sends, which is the same thing here.
export function scryluxFileSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(ScryluxFileV1, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
    override(context) {
      toJsonSchemaOverride(context);
      // A ticket is any http or https address with no whitespace, as the database accepts it; zod's own URL check is
      // laxer than a schema's `uri` format, which would reject a ticket the API stores (`…?y=<2>`).
      if (context.jsonSchema.format === 'uri') {
        delete context.jsonSchema.format;
        context.jsonSchema.pattern = '^[hH][tT][tT][pP][sS]?://\\S+$';
      }
    },
  }) as Record<string, unknown>;
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: 'scrylux-file-v1.schema.json',
    title: 'Scrylux file, format version 1',
    description: 'One threat model with its diagram, threats and mitigations, exported by Scrylux and importable into any Scrylux install.',
    ...rest,
  };
}

// `pnpm --filter @scrylux/api formats` rewrites the committed copy. The server never reads it.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  const target = fileURLToPath(new URL('../../../../docs/formats/scrylux-file-v1.schema.json', import.meta.url));
  writeFileSync(target, `${JSON.stringify(scryluxFileSchema(), null, 2)}\n`);
  console.log(`Wrote ${target}`);
}
