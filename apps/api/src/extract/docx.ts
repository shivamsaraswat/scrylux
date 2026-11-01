import { SaxesParser, type SaxesTagNS } from 'saxes';
import yauzl from 'yauzl';
import type { Block, ExtractFailure, ExtractLimits, ExtractSuccess, MemoryGuard } from './types.js';

// Reading a Word file's text (Phase 3 Milestone 3, FR-011, FR-012, FR-014, research #5), in the extraction child. A .docx is
// a ZIP archive of XML parts. Only three are opened: the content types, the main document and the styles. Nothing else in the
// archive is read: no macro, no embedded object, no image, no header, footer, comment or footnote, and no relationship to
// an outside address is followed. Each part's size is checked against the size its header declares, and against the bound.

const MAX_ENTRIES = 10_000;
const WORDML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MAIN_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
];
const MACRO_TYPE = 'application/vnd.ms-word.document.macroEnabled.main+xml';
const PARTS = ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml'] as const;
type PartName = (typeof PARTS)[number];

class Refused extends Error {
  constructor(readonly failure: ExtractFailure) {
    super(failure.category);
  }
}

function openArchive(bytes: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => (error ? reject(error) : resolve(zip)));
  });
}

function readStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const parts: Buffer[] = [];
      stream.on('data', (part: Buffer) => parts.push(part));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(parts)));
    });
  });
}

/** The three parts, as text. A part that is missing is absent; one that passes the bound refuses the file. */
async function readParts(bytes: Uint8Array, limits: ExtractLimits, guard: MemoryGuard): Promise<Partial<Record<PartName, string>>> {
  const zip = await openArchive(Buffer.from(bytes));
  if (zip.entryCount > MAX_ENTRIES) {
    zip.close();
    throw new Refused({ ok: false, category: 'too_large_unpacked' });
  }
  const found: Partial<Record<PartName, string>> = {};
  let declared = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        guard();
        const name = PARTS.find((part) => part === entry.fileName);
        if (name === undefined) {
          zip.readEntry();
          return;
        }
        declared += entry.uncompressedSize;
        if (declared > limits.unpackedBytes) {
          reject(new Refused({ ok: false, category: 'too_large_unpacked' }));
          return;
        }
        readStream(zip, entry).then(
          (content) => {
            found[name] = content.toString('utf8');
            zip.readEntry();
          },
          reject,
        );
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return found;
}

/** A parse of XML that refuses a document type declaration, which Word never writes and which could declare entities. */
function parseXml(xml: string, handlers: { open?: (tag: SaxesTagNS) => void; close?: (tag: SaxesTagNS) => void; text?: (text: string) => void }, guard: MemoryGuard): void {
  if (/<!DOCTYPE/i.test(xml)) throw new Refused({ ok: false, category: 'damaged' });
  const parser = new SaxesParser({ xmlns: true });
  let events = 0;
  const tick = (): void => {
    if (++events % 2000 === 0) guard();
  };
  parser.on('opentag', (tag) => {
    tick();
    handlers.open?.(tag);
  });
  parser.on('closetag', (tag) => handlers.close?.(tag));
  parser.on('text', (text) => handlers.text?.(text));
  parser.on('cdata', (text) => handlers.text?.(text));
  parser.write(xml).close();
}

const attribute = (tag: SaxesTagNS, local: string): string | undefined => {
  for (const attr of Object.values(tag.attributes)) if (attr.local === local) return attr.value;
  return undefined;
};

/** The content type of the main part, from [Content_Types].xml. */
function mainContentType(xml: string, guard: MemoryGuard): string | undefined {
  let type: string | undefined;
  parseXml(
    xml,
    {
      open: (tag) => {
        if (tag.local === 'Override' && attribute(tag, 'PartName') === '/word/document.xml') type = attribute(tag, 'ContentType');
      },
    },
    guard,
  );
  return type;
}

/** Style id to lower-case style name, so that a heading is found by its name, which is the same in every language of Word. */
function styleNames(xml: string | undefined, guard: MemoryGuard): Map<string, string> {
  const names = new Map<string, string>();
  if (xml === undefined) return names;
  let current: string | undefined;
  parseXml(
    xml,
    {
      open: (tag) => {
        if (tag.uri !== WORDML) return;
        if (tag.local === 'style') current = attribute(tag, 'styleId');
        else if (tag.local === 'name' && current !== undefined) names.set(current, (attribute(tag, 'val') ?? '').toLowerCase());
      },
      close: (tag) => {
        if (tag.uri === WORDML && tag.local === 'style') current = undefined;
      },
    },
    guard,
  );
  return names;
}

const HEADING_NAME = /^(?:heading ?[1-9]|title)$/;

function readBlocks(xml: string, styles: Map<string, string>, guard: MemoryGuard): Block[] {
  const blocks: Block[] = [];
  let paragraph: { text: string; styleId?: string; outline: boolean } | undefined;
  let inText = false;
  // Tables: only the outermost one is structured. A table inside a cell is flattened into the cell's text.
  let tableDepth = 0;
  let rows: string[][] = [];
  let row: string[] = [];
  let cell: string[] = [];

  const isHeading = (p: { styleId?: string; outline: boolean }): boolean => {
    if (p.outline) return true;
    if (p.styleId === undefined) return false;
    const name = styles.get(p.styleId) ?? p.styleId.toLowerCase();
    return HEADING_NAME.test(name);
  };

  parseXml(
    xml,
    {
      open: (tag) => {
        if (tag.uri !== WORDML) return;
        switch (tag.local) {
          case 'p':
            paragraph = { text: '', outline: false };
            break;
          case 'pStyle':
            if (paragraph) paragraph.styleId = attribute(tag, 'val');
            break;
          case 'outlineLvl': {
            const level = Number(attribute(tag, 'val'));
            if (paragraph && Number.isInteger(level) && level >= 0 && level <= 8) paragraph.outline = true;
            break;
          }
          case 't':
            inText = true;
            break;
          case 'tab':
            if (paragraph) paragraph.text += '\t';
            break;
          case 'br':
          case 'cr':
            if (paragraph) paragraph.text += '\n';
            break;
          case 'tbl':
            tableDepth++;
            if (tableDepth === 1) rows = [];
            break;
          case 'tr':
            if (tableDepth === 1) row = [];
            break;
          case 'tc':
            if (tableDepth === 1) cell = [];
            break;
          default:
            break;
        }
      },
      text: (text) => {
        if (inText && paragraph) paragraph.text += text;
      },
      close: (tag) => {
        if (tag.uri !== WORDML) return;
        switch (tag.local) {
          case 't':
            inText = false;
            break;
          case 'p': {
            if (!paragraph) break;
            const finished = paragraph;
            paragraph = undefined;
            const text = finished.text.trim();
            if (tableDepth > 0) {
              if (text !== '') cell.push(text);
            } else if (text !== '') {
              blocks.push(isHeading(finished) ? { text, isHeading: true } : { text });
            }
            break;
          }
          case 'tc':
            if (tableDepth === 1) row.push(cell.join(' '));
            break;
          case 'tr':
            if (tableDepth === 1) rows.push(row);
            break;
          case 'tbl': {
            tableDepth--;
            if (tableDepth === 0) {
              const text = rows.map((r) => r.join('\t')).join('\n');
              if (text.replace(/[\t\n ]/g, '') !== '') blocks.push({ text });
            }
            break;
          }
          default:
            break;
        }
      },
    },
    guard,
  );
  return blocks;
}

export async function readDocx(bytes: Uint8Array, limits: ExtractLimits, guard: MemoryGuard): Promise<ExtractSuccess | ExtractFailure> {
  try {
    const parts = await readParts(bytes, limits, guard);
    const document = parts['word/document.xml'];
    const types = parts['[Content_Types].xml'];
    if (document === undefined || types === undefined) return { ok: false, category: 'damaged' };
    const type = mainContentType(types, guard);
    // A macro-enabled document (.docm) is a valid archive that only its content types tell apart (FR-003, research #5).
    if (type === MACRO_TYPE) return { ok: false, category: 'unsupported_type' };
    if (type === undefined || !MAIN_TYPES.includes(type)) return { ok: false, category: 'unsupported_type' };
    const blocks = readBlocks(document, styleNames(parts['word/styles.xml'], guard), guard);
    return { ok: true, blocks, pagesWithoutText: null };
  } catch (error) {
    if (error instanceof Refused) return error.failure;
    return { ok: false, category: 'damaged' };
  }
}
