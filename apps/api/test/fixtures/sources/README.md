# Source fixtures

The documents the ingestion tests read (Phase 3 Milestone 3). They are built when a test runs, so that no binary is
committed and every byte can be read in the builder that makes it.

- `pdf.ts` builds PDFs: pages of text, pages that only draw (a scanned page), U+0000 in the text layer, a file that
  needs a password, a JavaScript action and links to a local address, any number of pages, and padding to a size.
  `textPages(n)` makes pages of text whose extracted text is at most `n` characters.
- `zip.ts` builds ZIP archives and the Word files made of them: headings, tables, a macro-enabled document, a
  document type declaration, a missing main part, external relationships, and entries that lie about their size.

The encrypted PDF is made by `pdf({ userPassword })`: the standard security handler, revision 2 (RC4 with a 40-bit
key), written out in `pdf.ts`. `pdfjs-dist` raises its password exception on it and opens it with the password. A
file made by `qpdf --encrypt <user> <owner> 40 -- in.pdf out.pdf` is read the same way.
