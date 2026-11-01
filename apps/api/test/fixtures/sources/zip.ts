import { crc32, deflateRawSync } from 'node:zlib';

// Builds ZIP archives and the Word files made of them, at test time, so that no binary fixture is committed
// (Phase 3 Milestone 3, T004). Small on purpose: stored or deflated entries, no encryption, no ZIP64.

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
  /** Stored by default. A deflated entry of a long run of one byte is how a small file unpacks to a large one. */
  method?: 'store' | 'deflate';
  /** What the headers say the unpacked size is, when it should differ from the truth (a lying archive). */
  declaredSize?: number;
}

const bytes = (data: Uint8Array | string): Buffer => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));

function localHeader(entry: { name: Buffer; method: number; crc: number; compressed: number; size: number }): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0x0800, 6); // flags: the name is UTF-8
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(0, 10); // time
  header.writeUInt16LE(0x21, 12); // date: 1980-01-01
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([header, entry.name]);
}

function centralHeader(entry: { name: Buffer; method: number; crc: number; compressed: number; size: number; offset: number }): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

/** A ZIP archive holding the entries, in order. */
export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = bytes(entry.data);
    const deflate = entry.method === 'deflate';
    const stored = deflate ? deflateRawSync(raw) : raw;
    const info = {
      name: Buffer.from(entry.name, 'utf8'),
      method: deflate ? 8 : 0,
      crc: crc32(raw),
      compressed: stored.length,
      size: entry.declaredSize ?? raw.length,
    };
    const local = Buffer.concat([localHeader(info), stored]);
    central.push(centralHeader({ ...info, offset }));
    parts.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

export type DocxBlock =
  /** A paragraph. `style` is a style id of `styles.xml`: Heading1, Heading2, Title or Normal. */
  | { paragraph: string; style?: 'Heading1' | 'Heading2' | 'Title' | 'Normal'; lineBreak?: boolean }
  | { table: string[][] };

export interface DocxOptions {
  blocks: DocxBlock[];
  /** A macro-enabled document (.docm): the main part's content type says so. */
  macro?: boolean;
  /** A document type declaration in the main part, which Word never writes. */
  doctype?: boolean;
  /** Leave out word/document.xml. */
  withoutMain?: boolean;
  /** Relationships to this address, as an external image and an external hyperlink. */
  externalUrl?: string;
  /** Extra entries, for example a large one to make a small file unpack to a lot. */
  extra?: ZipEntry[];
  method?: 'store' | 'deflate';
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const MACRO_TYPE = 'application/vnd.ms-word.document.macroEnabled.main+xml';

function paragraphXml(text: string, style: string | undefined, lineBreak: boolean | undefined): string {
  const pPr = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`;
  const runs = lineBreak === true ? text.split('\n').map((part) => `<w:r><w:t xml:space="preserve">${escapeXml(part)}</w:t></w:r>`).join('<w:r><w:br/></w:r>') : `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  return `<w:p>${pPr}${runs}</w:p>`;
}

function blockXml(block: DocxBlock): string {
  if ('table' in block) {
    const rows = block.table
      .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraphXml(cell, undefined, false)}</w:tc>`).join('')}</w:tr>`)
      .join('');
    return `<w:tbl>${rows}</w:tbl>`;
  }
  return paragraphXml(block.paragraph, block.style, block.lineBreak);
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
</w:styles>`;

/** A .docx (or, with `macro`, a .docm) file. */
export function docx(options: DocxOptions): Buffer {
  const method = options.method ?? 'deflate';
  const body = options.blocks.map(blockXml).join('');
  const external =
    options.externalUrl === undefined
      ? ''
      : '<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdImage"/></w:drawing></w:r></w:p>';
  const doctype = options.doctype === true ? '<!DOCTYPE w:document [<!ENTITY x "x">]>' : '';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${doctype}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}${external}</w:body></w:document>`;
  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${options.macro === true ? MACRO_TYPE : MAIN_TYPE}"/></Types>`,
      method,
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      method,
    },
    { name: 'word/styles.xml', data: STYLES, method },
  ];
  if (options.withoutMain !== true) entries.push({ name: 'word/document.xml', data: document, method });
  if (options.externalUrl !== undefined) {
    entries.push({
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${options.externalUrl}/link" TargetMode="External"/><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${options.externalUrl}/image.png" TargetMode="External"/></Relationships>`,
      method,
    });
  }
  entries.push(...(options.extra ?? []));
  return zip(entries);
}
