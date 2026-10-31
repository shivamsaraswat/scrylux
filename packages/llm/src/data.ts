import { readFileSync } from 'node:fs';
import { isAlias, isNode, parseDocument, visit } from 'yaml';

// The layer's data files (prices, model capabilities) and prompts are versioned files in the package, read from the
// module's own path and never chosen by an install (Principle IV, FR-041).

/**
 * Strict YAML 1.2, the way @scrylux/threat-library reads its rules: the core schema, so `yes` is text and a date stays
 * text; duplicate keys, anchors, aliases, unresolved tags and several documents are refused, and a parser warning
 * counts as an error. The message names the file.
 */
export function parseStrictYaml(file: string, text: string): unknown {
  const doc = parseDocument(text, { version: '1.2', schema: 'core', uniqueKeys: true, prettyErrors: true });
  const problems: string[] = [];
  for (const problem of [...doc.errors, ...doc.warnings]) {
    const line = problem.linePos?.[0].line;
    const reason = (problem.message.split('\n')[0] ?? 'invalid YAML').replace(/ at line \d+, column \d+:$/, '');
    problems.push(line === undefined ? reason : `${reason} (line ${line})`);
  }
  if (problems.length === 0) {
    visit(doc, (_key, node) => {
      if (isAlias(node)) problems.push('aliases are not allowed: write each entry out in full');
      else if (isNode(node) && node.anchor) problems.push('anchors are not allowed: write each entry out in full');
    });
  }
  if (problems.length > 0) throw new Error(`${file}: ${problems.join('; ')}`);
  return doc.toJS() as unknown;
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;

/**
 * Replaces each `{{name}}` in one pass. Text inserted for a placeholder is never searched again, so content that
 * contains `{{nonce}}` is not expanded. It throws when the text and the values do not name the same placeholders.
 */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  const inText = new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string));
  for (const name of inText) if (!(name in values)) throw new Error(`the text has a placeholder {{${name}}} with no value`);
  for (const name of Object.keys(values)) if (!inText.has(name)) throw new Error(`the text has no placeholder {{${name}}}`);
  return text.replace(PLACEHOLDER, (_m, name: string) => values[name] as string);
}

/**
 * Memoizes a loader. A failure is remembered and thrown again, so a broken file fails every use, not only the first.
 */
export function memoized<T>(load: () => T): () => T {
  let outcome: { value: T } | { error: unknown } | undefined;
  return () => {
    if (outcome === undefined) {
      try {
        outcome = { value: load() };
      } catch (error) {
        outcome = { error };
      }
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  };
}

const DATA = new URL('../data/', import.meta.url);
const PROMPTS = new URL('../prompts/', import.meta.url);

const cache = new Map<string, () => string>();
function read(base: URL, name: string): string {
  const key = new URL(name, base).href;
  let load = cache.get(key);
  if (load === undefined) {
    load = memoized(() => readFileSync(new URL(name, base), 'utf8'));
    cache.set(key, load);
  }
  return load();
}

/** The text of a file in the package's `data/` directory. */
export function loadData(name: string): string {
  return read(DATA, name);
}

/** The text of a file in the package's `prompts/` directory. */
export function loadPrompt(name: string): string {
  return read(PROMPTS, name);
}
