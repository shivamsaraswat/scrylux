import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard test (Phase 3 Milestone 2, research #2, FR-070): which code each process can reach, by its static imports. The worker
// is a second entry point of the API application, so this holds the line between them: the worker never imports Express or a
// route, and the API process never reaches the code that sends a provider request. It reads the source as text, so it passes
// when written: it checks what the earlier tasks built.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

interface Reached {
  files: Set<string>;
  packages: Set<string>;
  /** Names imported from a package, per package: `@scrylux/llm` → { createLlm, … }. */
  names: Map<string, Set<string>>;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:([\w*\s{},]+?)\s+from\s+)?'([^']+)'/g;

function resolveRelative(from: string, specifier: string): string {
  return path.resolve(path.dirname(from), specifier.replace(/\.js$/, '.ts'));
}

/** Every file reached from `entry` through static imports and re-exports, and every package those files import. */
function reach(entry: string): Reached {
  const reached: Reached = { files: new Set(), packages: new Set(), names: new Map() };
  const queue = [path.join(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (reached.files.has(file)) continue;
    reached.files.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const [, clause, specifier] = match;
      if (specifier === undefined) continue;
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier));
        continue;
      }
      const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] as string);
      reached.packages.add(pkg);
      const names = reached.names.get(pkg) ?? new Set<string>();
      for (const part of (clause ?? '').replace(/[{}]/g, ',').split(',')) {
        const name = part.replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
        if (name) names.add(name);
      }
      reached.names.set(pkg, names);
    }
  }
  return reached;
}

const relative = (files: Set<string>): string[] => [...files].map((f) => path.relative(SRC, f)).sort();

describe('the worker’s entry point (research #2)', () => {
  const worker = reach('worker.ts');

  it('reaches the worker’s own code, so the walk is real', () => {
    const files = relative(worker.files);
    expect(files).toEqual(expect.arrayContaining(['worker.ts', 'worker/loop.ts', 'worker/run.ts', 'worker/kinds.ts', 'jobs/store.ts', 'provider-check.ts', 'config.ts', 'db.ts']));
  });

  it('never reaches Express', () => {
    expect([...worker.packages]).not.toContain('express');
  });

  it('never reaches the web application: not app.ts, not a route, not the v1 operations', () => {
    const files = relative(worker.files);
    expect(files.filter((f) => f === 'app.ts' || f.startsWith('routes/') || f.startsWith('v1/') || f === 'web.ts' || f === 'server.ts')).toEqual([]);
  });

  it('never reaches the password hashing or the tokens of the web sign-in', () => {
    expect([...worker.packages].filter((p) => ['bcryptjs', 'jsonwebtoken'].includes(p))).toEqual([]);
  });
});

describe('the API process (FR-070)', () => {
  const server = reach('server.ts');

  it('reaches the whole web application, so the walk is real', () => {
    const files = relative(server.files);
    expect(files).toEqual(expect.arrayContaining(['server.ts', 'app.ts', 'v1/jobs.ts', 'jobs/store.ts', 'llm-startup.ts']));
    expect([...server.packages]).toContain('express');
  });

  it('never reaches the code that sends a provider request: no provider check, no worker', () => {
    const files = relative(server.files);
    expect(files.filter((f) => f === 'provider-check.ts' || f.startsWith('worker/') || f === 'worker.ts' || f === 'llm-check.ts')).toEqual([]);
  });

  it('never imports the client that talks to a provider from @scrylux/llm', () => {
    const names = server.names.get('@scrylux/llm') ?? new Set<string>();
    expect(names.size).toBeGreaterThan(0);
    expect([...names].filter((n) => n === 'createLlm' || n === 'createLlmInternal' || n === 'checkRequest')).toEqual([]);
  });

  it('may read the layer’s configuration and pure helpers, which send nothing', () => {
    const names = server.names.get('@scrylux/llm') ?? new Set<string>();
    expect(names.has('parseLlmStatus')).toBe(true);
  });
});

// Phase 3 Milestone 3, FR-010: the files of a document are read by the worker, in a child that holds no secret, and by nothing
// else. The API process never reaches the readers or the parsers, and the child reaches no module that knows the database,
// the configuration, the storage or a provider.
const PARSERS = ['pdfjs-dist', 'yauzl', 'saxes'];

describe('reading documents (FR-010)', () => {
  it('is never reachable from the API process: no extract module, no parser', () => {
    const server = reach('server.ts');
    expect(relative(server.files).filter((f) => f.startsWith('extract/'))).toEqual([]);
    expect([...server.packages].filter((p) => PARSERS.includes(p))).toEqual([]);
  });

  it('is started by the worker, which does not load the parsers itself, so the walk is real', () => {
    const worker = reach('worker.ts');
    expect(relative(worker.files)).toContain('extract/run.ts');
    expect(relative(worker.files).filter((f) => f === 'extract/child.ts' || f === 'extract/pdf.ts' || f === 'extract/docx.ts')).toEqual([]);
    expect([...worker.packages].filter((p) => PARSERS.includes(p))).toEqual([]);
  });

  it('is done by a child that reaches only the readers, their types and the parsers', () => {
    const child = reach('extract/child.ts');
    expect(relative(child.files)).toEqual(['extract/child.ts', 'extract/docx.ts', 'extract/pdf.ts', 'extract/types.ts']);
    const packages = [...child.packages].filter((p) => !p.startsWith('node:'));
    expect(packages.sort()).toEqual([...PARSERS].sort());
  });

  it('is done by a child that imports no workspace package, because it runs with no environment and no build conditions', () => {
    expect([...reach('extract/child.ts').packages].filter((p) => p.startsWith('@scrylux/'))).toEqual([]);
  });

  it('is done by a child that reaches no configuration, database, storage, provider or logging module', () => {
    const files = relative(reach('extract/child.ts').files);
    expect(files.filter((f) => /^(config|db|migrate|auth|llm|storage|jobs|worker|sources|v1)/.test(f) || f.includes('log'))).toEqual([]);
  });
});

describe('the walk itself', () => {
  it('sees an import and a re-export, a type import and a renamed name', () => {
    const text = [
      `import { a, type B, c as d } from '@x/y';`,
      `import type { E } from './local.js';`,
      `export { f } from '../other.js';`,
      `import 'side-effect';`,
    ].join('\n');
    const specifiers = [...text.matchAll(IMPORT)].map((m) => m[2]);
    expect(specifiers).toEqual(['@x/y', './local.js', '../other.js', 'side-effect']);
  });
});
