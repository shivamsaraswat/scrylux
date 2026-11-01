import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Constitution Principle I: an identifier built into a statement passes through the driver's identifier escaping, so the server's
// source holds no `sql.raw(` and no `sql.lit(`, which put text into a statement as it is. `sql.id(` escapes.
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : []));

describe('the server source', () => {
  it('puts no text into a statement as it is: no sql.raw and no sql.lit', () => {
    const found = files(SRC).filter((file) => /\bsql\.(raw|lit)\(/.test(readFileSync(file, 'utf8')));
    expect(found.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
