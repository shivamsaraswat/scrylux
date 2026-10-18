import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

// JSON Schema validators for the exchange suites. Scrylux's published schema is draft 2020-12; OTM's is draft-07, which is
// Ajv's default. Neither schema uses the `format` keyword, so no formats plugin is needed. The Scrylux schema is checked
// strictly, so a mistake in it fails here and not silently.

export function ajv2020(): Ajv2020 {
  return new Ajv2020({ strict: true, allErrors: true });
}

// OTM's own schema uses keywords (`$comment`, `nullable`) a strict validator refuses, and it is not Scrylux's to fix.
export function ajvDraft07(): Ajv {
  return new Ajv({ strict: false, allErrors: true });
}
