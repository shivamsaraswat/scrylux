import { z } from 'zod';
import { THREAT_MODEL_STATUSES } from '../enums.js';
import { ThreatModelRecord } from '../schemas/threat-model.js';
import { EXPORT_FORMATS, IMPORT_FORMATS, NAME_ISSUES, NOTE_KINDS } from './formats.js';

// The query of the export operation, GET /api/v1/threat-models/{id}/export. Like ReportQuery, a missing, unknown or
// repeated `format`, and any extra key, all get the one message, which names the formats and never repeats what the
// client sent. The error is set on the object as well as on the field, because an unknown key is reported against the
// object.
const EXPORT_MESSAGE = `format must be ${EXPORT_FORMATS.join(' or ')}`;
export const ExportQuery = z.strictObject({ format: z.enum(EXPORT_FORMATS, { error: EXPORT_MESSAGE }) }, { error: EXPORT_MESSAGE });
export type ExportQuery = z.infer<typeof ExportQuery>;

// The body of the check and import operations. `file` is checked only as "a JSON object": the handler bounds it and
// then parses it with the chosen format's schema, so no schema walks a file before its depth and size are known
// (research #6, FR-020). `names` is not checked here either: a name issue is reported by the check, not refused as a
// bad request.
export const ImportInput = z.strictObject({
  format: z.enum(IMPORT_FORMATS),
  names: z.array(z.string()).optional(),
  file: z.record(z.string(), z.unknown()).meta({ description: 'The parsed file, in the format named. Up to the documented size, nesting depth and value count.' }),
});
export type ImportInput = z.infer<typeof ImportInput>;

const count = z.number().int().min(0);

export const ImportModelSummary = z.strictObject({
  name: z.string(),
  name_issue: z.enum(NAME_ISSUES).nullable(),
  status: z.enum(THREAT_MODEL_STATUSES),
  elements: count,
  threats: count,
  mitigations: count,
  assets: count,
  assumptions: count,
});
export type ImportModelSummary = z.infer<typeof ImportModelSummary>;

// One thing in the file that was not carried over or was changed to fit (FR-016). `path` is the item's place in the
// file; `label` is its name from the file, shown as text; `detail` is from a fixed list.
export const ImportNote = z.strictObject({
  path: z.string(),
  kind: z.enum(NOTE_KINDS),
  label: z.string().optional(),
  detail: z.string().optional(),
});
export type ImportNote = z.infer<typeof ImportNote>;

export const ImportSummary = z.strictObject({
  models: z.array(ImportModelSummary),
  notes: z.array(ImportNote),
});
export type ImportSummary = z.infer<typeof ImportSummary>;

export const ImportResult = z.strictObject({
  threat_models: z.array(ThreatModelRecord),
  summary: ImportSummary,
});
export type ImportResult = z.infer<typeof ImportResult>;
