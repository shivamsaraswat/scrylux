// The vocabulary of Phase 2 Milestone 6 (import and export), defined once so the API, the web app and the tests agree.

// The formats an export can produce and an import can read. The lists grow story by story; every place that
// switches on a format is typed by them, so a format without a handler is a type error.
export const EXPORT_FORMATS = ['scrylux', 'otm'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const IMPORT_FORMATS = ['scrylux', 'otm', 'threat-dragon'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

// Raised with every change to the Scrylux file's shape (contracts/scrylux-file.md, "Versioning"). Version 1 is the file of Phase 2; it is what the OTM export marks
// its own objects with, and the OTM export did not change in Phase 3 Milestone 5.
export const SCRYLUX_FORMAT_VERSION = 1;

// The Scrylux file an export writes now: version 1 and the two lists of Phase 3 Milestone 5, assets and assumptions (FR-023). Version 1 files are still read.
export const SCRYLUX_FILE_VERSION = 2;
export const SCRYLUX_FILE_VERSIONS = [1, 2] as const;

// What a file of another version is told: the version this install reads, and the file's own, so a file from a newer
// Scrylux says what it is. The file's version is repeated only when it is a whole number from 1 to 999: nothing else from a
// file is ever echoed back.
export function formatVersionMessage(found: unknown, readable: readonly number[] = [SCRYLUX_FORMAT_VERSION]): string {
  const reads = `must be ${readable.join(' or ')}`;
  return typeof found === 'number' && Number.isInteger(found) && found >= 1 && found <= 999 ? `${reads}; this file is version ${found}` : reads;
}

// The bounds of an import (research #6, #14, FR-020): the most bytes a request body may hold, how deep a file may nest
// and how many values it may hold. The last two are checked, without recursion, before any schema walks a file.
export const IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const IMPORT_MAX_DEPTH = 64;
export const IMPORT_MAX_VALUES = 2_000_000;

// Everything an import leaves out or changes is listed in its summary under one of these kinds (data-model.md,
// "Note kinds"). The web app words each one.
export const NOTE_KINDS = [
  'not_imported.boundary_line',
  'not_imported.text_block',
  'not_imported.dangling_flow',
  'not_imported.asset',
  'not_imported.representation',
  'not_imported.threat_category',
  'not_imported.field',
  'moved.model_level',
  'moved.nearest_zone',
  'mapped.component_type',
  'mapped.status',
  'mapped.severity',
  'mapped.risk_clamped',
  'adjusted.shortened',
  'adjusted.unnamed',
  'adjusted.tags',
  'adjusted.layout',
] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// What can be wrong with the name a model would be created under. A name issue is reported by a check and refused
// by the import (data-model.md, "Import request and response").
export const NAME_ISSUES = ['empty', 'too_long', 'duplicate', 'taken'] as const;
export type NameIssue = (typeof NAME_ISSUES)[number];
