import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LibraryLoadError } from './errors.js';
import type { Library } from './library.js';
import { parseLibrary, type ParseOptions, type RuleSourceFile } from './parse.js';

// Reads every file under `directory`, skipping names that start with a dot (.DS_Store and editor
// files). Paths are relative and use '/'. A symbolic link is refused rather than followed or skipped,
// so a rule can never be silently dropped.
function readRuleFiles(directory: string): RuleSourceFile[] {
  const files: RuleSourceFile[] = [];
  const walk = (relative: string): void => {
    const absolute = relative === '' ? directory : `${directory}/${relative}`;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new LibraryLoadError([
          {
            file: path,
            rule: null,
            message: 'symbolic links are not allowed in the rules directory',
          },
        ]);
      }
      if (entry.isDirectory()) walk(path);
      else files.push({ path, text: readFileSync(`${absolute}/${entry.name}`, 'utf8') });
    }
  };
  walk('');
  return files;
}

// Coverage is required unless the caller turns it off, which only tests do.
export function loadLibrary(rulesDirectory: string, options: ParseOptions = {}): Library {
  return parseLibrary(readRuleFiles(rulesDirectory), {
    requireCoverage: options.requireCoverage ?? true,
  });
}

// The package's own rules/, resolved from this module and not from the working directory or the
// environment, like the migrations in @scrylux/db. Loaded once; a failure is remembered and thrown
// again, so a broken catalog is never half-used.
let shipped: { library: Library } | { error: unknown } | undefined;

export function shippedLibrary(): Library {
  if (shipped === undefined) {
    try {
      const directory = fileURLToPath(new URL('../rules', import.meta.url));
      shipped = { library: loadLibrary(directory, { requireCoverage: true }) };
    } catch (error) {
      shipped = { error };
    }
  }
  if ('error' in shipped) throw shipped.error;
  return shipped.library;
}
