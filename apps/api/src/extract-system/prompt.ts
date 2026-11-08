import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DraftAnswer } from '@scrylux/core';
import { isAlias, isNode, parseDocument, visit } from 'yaml';
import { z } from 'zod';

// The prompt files of an extraction (Phase 3 Milestone 4, contracts/data-files.md, research #12): the instructions and the
// queries that choose chunks are versioned data in the repository (Principle IV), read from apps/api/prompts/extract-system, which
// sits next to `src` and `dist` so that one path serves both. Every draft records the version, which is a hash of the two files and
// of the schema of the answer, so a change to any of them changes it without anyone remembering to bump a number, and Milestone 7
// can record its results by it.

/** Every file of the directory, in the order the version hashes them. A test holds this equal to the directory's files. */
export const PROMPT_FILES = ['instructions.md', 'retrieval-queries.yaml'] as const;

const DIRECTORY = new URL('../../prompts/extract-system/', import.meta.url);

export interface PromptFiles {
  instructions: string;
  queries: string;
}

export interface ExtractionPrompt {
  /** Goes in the provider's instruction position. Holds nothing from a source. */
  instructions: string;
  /** Fixed text, embedded to choose chunks on the retrieval path (FR-012). */
  queries: string[];
  /** `extract-system/` and twelve hex digits. */
  version: string;
}

const queriesFile = z.strictObject({
  queries: z.array(z.string().min(1).max(300)).min(1).max(16),
});

/**
 * Strict YAML 1.2 as the other data files are read: the core schema, and anchors, aliases, duplicate keys and several documents
 * refused. Then the shape: 1 to 16 non-empty strings of at most 300 characters (contracts/data-files.md).
 */
export function parseQueries(source: string): string[] {
  const doc = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true });
  const problems = [...doc.errors, ...doc.warnings].map((problem) => problem.message.split('\n')[0] ?? 'invalid YAML');
  if (problems.length === 0) {
    visit(doc, (_key, node) => {
      if (isAlias(node)) problems.push('aliases are not allowed');
      else if (isNode(node) && node.anchor) problems.push('anchors are not allowed');
    });
  }
  if (problems.length > 0) throw new Error(`prompts/extract-system/retrieval-queries.yaml is not valid YAML: ${problems.join('; ')}`);
  const parsed = queriesFile.safeParse(doc.toJS());
  if (!parsed.success) {
    // The problem is named by its path and its rule, as everywhere: a query's own text is not repeated.
    const where = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'the file'}: ${issue.message}`);
    const count = parsed.error.issues.some((issue) => issue.path[0] === 'queries' && issue.path.length === 1) ? ' (1 to 16 queries)' : '';
    throw new Error(`prompts/extract-system/retrieval-queries.yaml is not valid${count}: ${where.join('; ')}`);
  }
  return parsed.data.queries;
}

/**
 * The version of a prompt: twelve hex digits of a SHA-256 over the instructions, the queries and the answer's JSON Schema, in that
 * order. Each is hashed with its length first, so that moving text from one to the next changes the hash.
 */
export function promptVersion(files: PromptFiles, answerSchema: string): string {
  const hash = createHash('sha256');
  for (const part of [files.instructions, files.queries, answerSchema]) {
    hash.update(`${Buffer.byteLength(part)}:`);
    hash.update(part);
    hash.update('\n');
  }
  return `extract-system/${hash.digest('hex').slice(0, 12)}`;
}

let loaded: ExtractionPrompt | undefined;

/** The shipped files, read once. The JSON Schema of the answer is the one a provider is sent, with no request's checks in it. */
export function loadExtractionPrompt(): ExtractionPrompt {
  if (loaded !== undefined) return loaded;
  const instructions = readFileSync(new URL('instructions.md', DIRECTORY), 'utf8');
  const queriesSource = readFileSync(new URL('retrieval-queries.yaml', DIRECTORY), 'utf8');
  const answerSchema = JSON.stringify(z.toJSONSchema(DraftAnswer, { target: 'draft-2020-12' }));
  loaded = {
    instructions: instructions.trim(),
    queries: parseQueries(queriesSource),
    version: promptVersion({ instructions, queries: queriesSource }, answerSchema),
  };
  return loaded;
}
