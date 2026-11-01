import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// pdf.js once compiled font programs with `new Function`, which let a crafted PDF run code (CVE-2024-4367) unless the
// option `isEvalSupported` was set to false. Version 6 has neither the code nor the option, so the extraction child sets
// nothing (Phase 3 Milestone 3, research #4). This test keeps that true: if an upgrade brings either back, it fails, and
// the person upgrading has to decide, which is the point.

const require = createRequire(import.meta.url);
const BUILD = join(dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build');
// The files the extraction child loads. pdf.sandbox.mjs is the sandbox for the JavaScript of PDF forms, which a viewer loads
// only when it turns scripting on: the reader does not, and a test below holds it to that.
const LOADED = ['pdf.mjs', 'pdf.worker.mjs'];
const files = readdirSync(BUILD).filter((name) => LOADED.includes(name));

describe('the installed pdf.js', () => {
  it('has the files the extraction child loads', () => {
    expect([...files].sort()).toEqual([...LOADED].sort());
  });

  it('is never asked to run the scripts of a PDF: the reader does not enable scripting', () => {
    const reader = readFileSync(new URL('../../src/extract/pdf.ts', import.meta.url), 'utf8');
    expect(reader.replace(/\/\/.*$/gm, '')).not.toMatch(/enableScripting|pdf\.sandbox/);
  });

  it.each(files)('%s evaluates no code: no eval(), no new Function()', (file) => {
    const text = readFileSync(join(BUILD, file), 'utf8');
    expect(text).not.toMatch(/\beval\s*\(/);
    expect(text).not.toMatch(/\bnew\s+Function\s*\(/);
  });

  it('has no isEvalSupported option; if it comes back, set it to false in extract/pdf.ts', () => {
    for (const file of files) expect(readFileSync(join(BUILD, file), 'utf8'), file).not.toContain('isEvalSupported');
  });
});
