// What the extraction child and the worker say to each other (Phase 3 Milestone 3, specs/phase-3/milestone-3-ingestion/
// contracts/worker.md). This file imports nothing: the child runs with no environment and loads no workspace package, so
// nothing that reads configuration, the database, storage or a provider can end up in its import graph (FR-010).

/** One piece of a document in reading order. A PDF gives one per page that has text; a Word file one per paragraph or table. */
export interface Block {
  text: string;
  /** PDFs: the page (1-based). */
  page?: number;
  /** Word files: this block is a heading, and its text is the heading. */
  isHeading?: boolean;
}

/** The bounds of reading one file (FR-011). */
export interface ExtractLimits {
  maxPages: number;
  /** Word files: the most the parts that are read may unpack to, by the size their headers declare. */
  unpackedBytes: number;
  /** The child exits when its resident memory passes this. */
  memoryMb: number;
  timeLimitMs: number;
}

export interface ExtractRequest {
  type: 'pdf' | 'docx';
  bytes: Uint8Array;
  limits: ExtractLimits;
}

export type ExtractFailureCategory = 'unsupported_type' | 'encrypted' | 'damaged' | 'too_large' | 'too_large_unpacked' | 'unreadable';

/** `detail` names the bound that was passed: time or memory for `unreadable`, pages for `too_large`. */
export interface ExtractFailure {
  ok: false;
  category: ExtractFailureCategory;
  detail?: 'time' | 'memory' | 'pages';
}

export interface ExtractSuccess {
  ok: true;
  blocks: Block[];
  /** PDFs: how many pages held no text (FR-014). Null for a Word file. */
  pagesWithoutText: number | null;
}

export type ExtractResult = ExtractSuccess | ExtractFailure;

/** Called between pages and parts: the child exits here when it has used more memory than it may. */
export type MemoryGuard = () => void;

/** The exit code of a child that passed its memory bound (contracts/worker.md). */
export const EXIT_MEMORY = 3;
