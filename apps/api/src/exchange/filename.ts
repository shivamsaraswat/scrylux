import type { ExportFormat } from '@scrylux/core';
import { fileSlug } from '../report/filename.js';

// The name a downloaded export is saved under: <slug>-<YYYY-MM-DD>.<format>.json. The slug is the report's, so a
// threat model's files are named alike, and the date is the UTC date of the export instant, the same instant the
// file's own export time shows.
export function exchangeFilename(name: string, format: ExportFormat, exportedAt: Date): string {
  return `${fileSlug(name)}-${exportedAt.toISOString().slice(0, 10)}.${format}.json`;
}
