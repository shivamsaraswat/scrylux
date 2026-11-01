import { createHash } from 'node:crypto';

// Builds PDF files at test time, so that no binary fixture is committed (Phase 3 Milestone 3, T004). Text is Helvetica in
// uncompressed content streams, one page per entry of `pages`. Only ASCII text can be written, which is all the tests need.

export interface PdfOptions {
  /** One entry per page: its text, lines separated by "\n", or null for a page that only draws a line (a scanned page). */
  pages: (string | null)[];
  /** Lets the text hold U+0000, which a text layer can emit: the font gets a ToUnicode map from code 1 to U+0000. */
  nul?: boolean;
  /** Encrypts the file (the standard handler, RC4 with a 40-bit key) so that opening it needs this password. */
  userPassword?: string;
  /** Adds a JavaScript open action, a link action to this address and a stream whose data is at this address (FR-012). */
  externalUrl?: string;
  /** Appends an unused stream so that the file is at least this many bytes, and under a hundred more. */
  padTo?: number;
}

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const FILE_ID = Buffer.from('5c1bd01e6e3d4a7a9d1f0c2b8a47e9f3', 'hex');
const PERMISSIONS = -44;

const md5 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 255;
    b = (b + s[a]!) & 255;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 255]!;
  }
  return out;
}

const padPassword = (password: string): Buffer => Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

interface Encryption {
  owner: Buffer;
  user: Buffer;
  key: Buffer;
}

/** The O and U values and the file key of the standard security handler, revision 2 (ISO 32000-1, 7.6.3.3 to 7.6.3.4). */
function encryption(userPassword: string): Encryption {
  const paddedUser = padPassword(userPassword);
  const owner = rc4(md5(padPassword('owner-password')).subarray(0, 5), paddedUser);
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(PERMISSIONS);
  const key = md5(paddedUser, owner, permissions, FILE_ID).subarray(0, 5);
  return { owner, user: rc4(key, PAD), key };
}

function objectKey(file: Buffer, num: number): Buffer {
  const suffix = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]);
  return md5(file, suffix).subarray(0, Math.min(file.length + 5, 16));
}

/** A PDF literal string. Anything but printable ASCII is refused, except U+0000 when the font maps it. */
function literal(text: string, nul: boolean): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0 && nul) out += '\\001';
    else if (char === '(' || char === ')' || char === '\\') out += `\\${char}`;
    else if (code >= 0x20 && code <= 0x7e) out += char;
    else throw new Error(`pdf fixture: cannot write U+${code.toString(16).padStart(4, '0')}`);
  }
  return `(${out})`;
}

function contentOf(text: string | null, nul: boolean): string {
  if (text === null) return '0.5 w 40 40 m 570 750 l S';
  const lines = text.split('\n').map((line) => `${literal(line, nul)} Tj`);
  return `BT /F1 10 Tf 12 TL 40 760 Td ${lines.join(' T* ')} ET`;
}

const TO_UNICODE = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <00> <FF> endcodespacerange
1 beginbfchar <01> <0000> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;

function assemble(options: PdfOptions, filler: number): Buffer {
  const nul = options.nul === true;
  const secure = options.userPassword === undefined ? undefined : encryption(options.userPassword);

  // Object numbers, fixed in advance because pages refer to each other.
  let next = 4;
  const toUnicodeNum = nul ? next++ : 0;
  const externalNum = options.externalUrl === undefined ? 0 : next++;
  const firstPage = next;
  const pageNum = (i: number): number => firstPage + i * 2;
  next = firstPage + options.pages.length * 2;
  const fillerNum = filler > 0 ? next++ : 0;
  const encryptNum = secure === undefined ? 0 : next++;
  const size = next;

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'latin1')];
  const offsets = new Map<number, number>();
  let position = chunks[0]!.length;
  const put = (num: number, body: string, stream?: Buffer): void => {
    offsets.set(num, position);
    let data = stream;
    if (data !== undefined && secure !== undefined) data = rc4(objectKey(secure.key, num), data);
    const parts =
      data === undefined
        ? [Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1')]
        : [
            // /Length goes in the outermost dictionary, which closes last.
            Buffer.from(`${num} 0 obj\n${body.slice(0, body.lastIndexOf('>>'))}/Length ${data.length} >>\nstream\n`, 'latin1'),
            data,
            Buffer.from('\nendstream\nendobj\n', 'latin1'),
          ];
    for (const part of parts) {
      chunks.push(part);
      position += part.length;
    }
  };

  const javascript = options.externalUrl === undefined ? '' : ` /OpenAction << /S /JavaScript /JS ${literal(`this.submitForm("${options.externalUrl}/js")`, false)} >>`;
  put(1, `<< /Type /Catalog /Pages 2 0 R${javascript} >>`);
  const kids = options.pages.map((_, i) => `${pageNum(i)} 0 R`).join(' ');
  put(2, `<< /Type /Pages /Kids [${kids}] /Count ${options.pages.length} >>`);
  const toUnicode = nul ? ` /ToUnicode ${toUnicodeNum} 0 R` : '';
  put(3, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding${toUnicode} >>`);
  if (nul) put(toUnicodeNum, '<< >>', Buffer.from(TO_UNICODE, 'latin1'));
  if (options.externalUrl !== undefined) {
    // A form whose data is not in the file but at an address: a reader that fetched it would reach the address.
    put(externalNum, `<< /Type /XObject /Subtype /Form /BBox [0 0 1 1] /F << /FS /URL /F ${literal(`${options.externalUrl}/stream`, false)} >> >>`, Buffer.alloc(0));
  }
  options.pages.forEach((text, i) => {
    const link =
      i === 0 && options.externalUrl !== undefined
        ? ` /Annots [<< /Type /Annot /Subtype /Link /Rect [40 700 200 720] /A << /S /URI /URI ${literal(`${options.externalUrl}/uri`, false)} >> >>]`
        : '';
    const xobject = options.externalUrl === undefined ? '' : ` /XObject << /X1 ${externalNum} 0 R >>`;
    put(pageNum(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${xobject} >> /Contents ${pageNum(i) + 1} 0 R${link} >>`);
    put(pageNum(i) + 1, '<< >>', Buffer.from(contentOf(text, nul), 'latin1'));
  });
  if (fillerNum !== 0) put(fillerNum, '<< >>', Buffer.alloc(filler, 0x20));
  if (secure !== undefined) {
    put(encryptNum, `<< /Filter /Standard /V 1 /R 2 /O <${secure.owner.toString('hex')}> /U <${secure.user.toString('hex')}> /P ${PERMISSIONS} >>`);
  }

  const xref = [`xref\n0 ${size}\n0000000000 65535 f \n`];
  for (let num = 1; num < size; num++) xref.push(`${String(offsets.get(num)).padStart(10, '0')} 00000 n \n`);
  const id = FILE_ID.toString('hex');
  const encrypt = secure === undefined ? '' : ` /Encrypt ${encryptNum} 0 R`;
  xref.push(`trailer\n<< /Size ${size} /Root 1 0 R${encrypt} /ID [<${id}> <${id}>] >>\nstartxref\n${position}\n%%EOF\n`);
  chunks.push(Buffer.from(xref.join(''), 'latin1'));
  return Buffer.concat(chunks);
}

/** A PDF file. */
export function pdf(options: PdfOptions): Buffer {
  const plain = assemble(options, 0);
  const wanted = options.padTo ?? 0;
  if (plain.length >= wanted) return plain;
  // The filler object adds a few bytes of its own, so ask for what is missing and the file is at least as large as wanted.
  return assemble(options, wanted - plain.length);
}

/**
 * Pages of English-like text, deterministic and ASCII, whose extracted text is at most `totalChars` characters, newlines
 * included. For the largest-document tests.
 */
export function textPages(totalChars: number, charsPerLine = 90, linesPerPage = 60): string[] {
  const words = ['service', 'request', 'record', 'gateway', 'token', 'store', 'queue', 'worker', 'session', 'policy', 'boundary', 'flow'];
  const pages: string[] = [];
  let lines: string[] = [];
  let used = 0;
  for (let n = 0; ; n++) {
    let line = '';
    for (let w = n; line.length < charsPerLine - 12; w++) line += `${words[w % words.length]!}${w} `;
    line = line.trimEnd();
    if (used + line.length + 1 > totalChars) break;
    used += line.length + 1;
    lines.push(line);
    if (lines.length === linesPerPage) {
      pages.push(lines.join('\n'));
      lines = [];
    }
  }
  if (lines.length > 0) pages.push(lines.join('\n'));
  return pages;
}
