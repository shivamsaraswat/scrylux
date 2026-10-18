import { z } from 'zod';
import {
  ELEMENT_TYPES,
  IMPACTS,
  LIKELIHOODS,
  METHODOLOGIES,
  MITIGATION_STATUSES,
  STRIDE_CATEGORIES,
  THREAT_MODEL_STATUSES,
  THREAT_ORIGINS,
  THREAT_STATUSES,
} from '../enums.js';
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, httpUrl, optionalText, requiredText } from '../fields.js';
import { normalizeElementShape } from '../schemas/element.js';
import { StaleReason } from '../schemas/stale.js';
import { SCRYLUX_FORMAT_VERSION, formatVersionMessage } from './formats.js';

// The Scrylux file, format version 1 (contracts/scrylux-file.md): one threat model, lossless. It is built from the same
// field schemas as the create inputs, so a file the schema accepts passes the field rules of FR-008 and one it rejects
// is refused by the import. Every key is always present, nullable where the contract says (so a diff shows every
// change on its own line), and no key may be added.
//
// What a schema cannot say is checked after it, by the import plan: references between records, nesting without
// cycles, the element limit, a reason only on accepted or not applicable threats, a stale mark only on generated
// threats, one generated threat per element and rule, and that no AI-drafted threat comes in (research #9).

// An id in a file is opaque: any string, 1 to 100 characters, unique across the file. An import replaces it.
const fileId = z.string().min(1).max(100).meta({ description: 'Any string; unique across the file. An import gives every record a new id.' });

const properties = z
  .strictObject({
    tags: z.array(z.string()).optional(),
    flags: z.record(z.string(), z.boolean()).optional(),
  })
  .meta({
    description:
      'Technology tags and security flags. A flag that is absent means "not assessed"; false means "no". The flags allowed depend on the element type.',
  });

const layout = z
  .strictObject({ x: z.number(), y: z.number(), width: z.number().optional(), height: z.number().optional() })
  .nullable()
  .meta({
    description:
      'null (never placed, and always for a data flow), { x, y } for a node, or { x, y, width, height } for a trust boundary. x and y are relative to the parent boundary, or to the diagram origin when there is none.',
  });

// The per-type rules of `properties` and `layout` are the API's own (normalizeElementShape), so they cannot drift.
const FileElement = z
  .strictObject({
    id: fileId,
    type: z.enum(ELEMENT_TYPES),
    name: requiredText(NAME_MAX_LENGTH),
    properties,
    layout,
    parent_boundary_id: fileId.nullable(),
    source_element_id: fileId.nullable(),
    target_element_id: fileId.nullable(),
  })
  .transform(normalizeElementShape);

const FileThreat = z.strictObject({
  id: fileId,
  element_id: fileId.nullable(),
  category: z.enum(STRIDE_CATEGORIES),
  title: requiredText(NAME_MAX_LENGTH),
  description: optionalText(DESCRIPTION_MAX_LENGTH),
  likelihood: z.enum(LIKELIHOODS),
  impact: z.enum(IMPACTS),
  status: z.enum(THREAT_STATUSES),
  status_reason: requiredText(DESCRIPTION_MAX_LENGTH).nullable(),
  origin: z.enum(THREAT_ORIGINS),
  library_ref: requiredText(NAME_MAX_LENGTH).nullable(),
  stale: StaleReason.nullable(),
});

const FileMitigation = z.strictObject({
  id: fileId,
  threat_id: fileId,
  description: requiredText(DESCRIPTION_MAX_LENGTH),
  status: z.enum(MITIGATION_STATUSES),
  external_ref: httpUrl.nullable(),
});

export const ScryluxFileV1 = z.strictObject({
  format: z.literal('scrylux'),
  format_version: z.literal(SCRYLUX_FORMAT_VERSION, { error: (issue) => formatVersionMessage(issue.input) }),
  exported_at: z.string().meta({ description: 'When the file was exported (ISO 8601, UTC). Ignored on import.' }),
  project: z.strictObject({ name: z.string() }).meta({ description: 'The project the model was exported from, for information. Ignored on import.' }),
  // The name is not limited here: an empty or over-long name is reported in the import's preview, where it can be
  // fixed, and refused only by the import itself (data-model.md, "Import request and response").
  threat_model: z.strictObject({ name: z.string(), methodology: z.enum(METHODOLOGIES), status: z.enum(THREAT_MODEL_STATUSES) }),
  elements: z.array(FileElement),
  threats: z.array(FileThreat),
  mitigations: z.array(FileMitigation),
});
export type ScryluxFileV1 = z.infer<typeof ScryluxFileV1>;
