import type { SourceType } from '@scrylux/core';

// What the API checks of an upload before it stores anything (Phase 3 Milestone 3, FR-003): the type of the file from its
// first bytes, which must agree with its extension, and for text that it is UTF-8 with no NUL. That is all. Reading a file's
// structure is parsing, which only the worker does, in a process that holds no secret (FR-010), so an Office file with macros
// (a .docm in a .docx's clothes) is a valid archive here and is refused by the worker.

export type SniffFailure =
  /** Nothing in the file. */
  | 'empty'
  /** The name has no supported extension. The file-name schema refuses it first; this is for a caller that skipped it. */
  | 'extension'
  /** The first bytes are not those of the type the extension names. */
  | 'mismatch'
  /** An OLE container: the older .doc format, or an encrypted Word file. Both use it. */
  | 'ole'
  | 'not_utf8'
  | 'nul';

export type SniffResult = { ok: true; type: Exclude<SourceType, 'text'> } | { ok: false; reason: SniffFailure };

const EXTENSION = /\.(md|txt|pdf|docx)$/i;
const PDF_HEADER = Buffer.from('%PDF-');
const PDF_WINDOW = 1024;
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const startsWith = (bytes: Uint8Array, signature: Buffer): boolean => bytes.length >= signature.length && Buffer.from(bytes.subarray(0, signature.length)).equals(signature);

function sniffText(bytes: Uint8Array): SniffFailure | undefined {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return 'not_utf8';
  }
  return bytes.includes(0) ? 'nul' : undefined;
}

/** The type of the file named `name`, if its bytes are that type's. Never reads past the first bytes of a binary file. */
export function sniffUpload(name: string, bytes: Uint8Array): SniffResult {
  const extension = EXTENSION.exec(name)?.[1]?.toLowerCase();
  if (extension === undefined) return { ok: false, reason: 'extension' };
  if (bytes.length === 0) return { ok: false, reason: 'empty' };

  if (extension === 'pdf') {
    return Buffer.from(bytes.subarray(0, PDF_WINDOW)).includes(PDF_HEADER) ? { ok: true, type: 'pdf' } : { ok: false, reason: 'mismatch' };
  }
  if (extension === 'docx') {
    if (startsWith(bytes, OLE_SIGNATURE)) return { ok: false, reason: 'ole' };
    return startsWith(bytes, ZIP_SIGNATURE) ? { ok: true, type: 'docx' } : { ok: false, reason: 'mismatch' };
  }
  const reason = sniffText(bytes);
  return reason === undefined ? { ok: true, type: extension === 'md' ? 'md' : 'txt' } : { ok: false, reason };
}

/**
 * Pasted text is ingested as if it were an uploaded UTF-8 .txt file: these are the bytes that are stored and hashed.
 * Encoding turns a lone surrogate into U+FFFD, so the text stored is the text measured.
 */
export function sniffPaste(text: string): { ok: true; bytes: Buffer } | { ok: false; reason: 'nul' } {
  if (text.includes('\u0000')) return { ok: false, reason: 'nul' };
  return { ok: true, bytes: Buffer.from(text, 'utf8') };
}
