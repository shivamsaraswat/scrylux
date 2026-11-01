import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Block, ExtractFailure, ExtractLimits, ExtractSuccess, MemoryGuard } from './types.js';

// Reading a PDF's text (Phase 3 Milestone 3, FR-011, FR-012, FR-014, research #4), in the extraction child. Nothing is
// evaluated, fetched or rendered: the CMaps and standard fonts are files from the installed package, and no page is drawn.
// pdf.js 6 has no `isEvalSupported` option because it has no code that evaluates a font program any more (the path of
// CVE-2024-4367): test/extract/pdfjs-no-eval.test.ts fails if a version ever brings one back. A file that needs a password is
// refused, never asked for one.

const require = createRequire(import.meta.url);
const PACKAGE_DIR = dirname(require.resolve('pdfjs-dist/package.json'));
const CMAP_URL = `${join(PACKAGE_DIR, 'cmaps')}/`;
const STANDARD_FONTS_URL = `${join(PACKAGE_DIR, 'standard_fonts')}/`;

interface TextItem {
  str: string;
  hasEOL?: boolean;
}
const isTextItem = (item: unknown): item is TextItem => typeof item === 'object' && item !== null && typeof (item as TextItem).str === 'string';

export async function readPdf(bytes: Uint8Array, limits: ExtractLimits, guard: MemoryGuard): Promise<ExtractSuccess | ExtractFailure> {
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    verbosity: 0,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
  });
  try {
    let document;
    try {
      document = await task.promise;
    } catch (error) {
      return { ok: false, category: (error as { name?: string }).name === 'PasswordException' ? 'encrypted' : 'damaged' };
    }
    if (document.numPages > limits.maxPages) return { ok: false, category: 'too_large', detail: 'pages' };

    const blocks: Block[] = [];
    let pagesWithoutText = 0;
    for (let number = 1; number <= document.numPages; number++) {
      guard();
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!isTextItem(item)) continue;
        text += item.str;
        if (item.hasEOL === true) text += '\n';
      }
      page.cleanup();
      text = text.trimEnd();
      if (text.trim() === '') pagesWithoutText++;
      else blocks.push({ text, page: number });
    }
    return { ok: true, blocks, pagesWithoutText };
  } catch {
    return { ok: false, category: 'damaged' };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
