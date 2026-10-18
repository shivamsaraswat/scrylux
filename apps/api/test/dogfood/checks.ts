import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ScryluxFileV1, STRIDE_CATEGORIES } from '@scrylux/core';
import { buildScryluxFile, serializeExport, type ExportedFile } from '../../src/exchange/scrylux-export.js';
import { ajv2020 } from '../exchange/ajv.js';
import { markdownInline } from '../../src/report/escape.js';
import { canonical, snapshotOf, type ExchangeFile } from '../exchange/fixtures.js';
import { PATTERNS } from './patterns.js';

// The checks of contracts/checks.md. Every function here takes what it needs as an argument and returns findings: none
// calls an operation, touches the database or reads a committed file, so each can be shown to fail on an input made
// to break it (checks.test.ts). The calls to the operations are in operations.ts, and the committed files are read in
// threat-model.test.ts.
//
// A message names a file, an element, a threat's title or a rule, never a description, a reason or a value the file
// holds, so a failing pull request cannot echo something it should not.

export const FOLDER = 'docs/threat-model';
export const SCRYLUX_FILE = `${FOLDER}/threat-model.scrylux.json`;
export const REPORT_FILE = `${FOLDER}/report.md`;
export const README_FILE = `${FOLDER}/README.md`;
export const FOLDER_NAMES: readonly string[] = ['README.md', 'report.md', 'threat-model.scrylux.json'];

export const PROJECT_NAME = 'Scrylux';
export const MODEL_NAME = 'Scrylux application';

const WHERE_TO_READ = 'See "Updating the model" in docs/threat-model/README.md.';

export interface Finding {
  check: string;
  file: string;
  message: string;
  fix: string;
}

// The two lines of a failure: where, which check and what is wrong; then the smallest thing to do.
export function formatFinding({ file, check, message, fix }: Finding): string {
  return `${file}: ${check}: ${message}.\nFix: ${fix}. ${WHERE_TO_READ}`;
}

// The line of a warning (check 6b): the build passes, and the reader is told how to catch the model up.
export function formatWarning({ message }: Finding): string {
  return `Scrylux's own threat model is behind its rules: ${message}. The build passes.\nUpdate docs/threat-model/ in this or a later change. ${WHERE_TO_READ}`;
}

const finding = (check: string, file: string, message: string, fix: string): Finding => ({ check, file, message, fix });

// ---------------------------------------------------------------------------------------------------------------
// 1, form

export type SchemaValidator = (value: unknown) => string[];

// The published JSON Schema of the Scrylux file (draft 2020-12, as schema-current.test.ts reads it), as a function
// that returns where a value breaks it. The messages carry the place and the rule, never the value.
export function publishedSchemaValidator(): SchemaValidator {
  const path = fileURLToPath(new URL('../../../../docs/formats/scrylux-file-v1.schema.json', import.meta.url));
  const validate = ajv2020().compile(JSON.parse(readFileSync(path, 'utf8')) as object);
  return (value) => {
    if (validate(value)) return [];
    return (validate.errors ?? []).slice(0, 5).map((error) => `${error.instancePath === '' ? 'the file' : error.instancePath}: ${error.message ?? 'is not valid'}`);
  };
}

export function checkForm(file: string, text: string, validate: SchemaValidator): Finding[] {
  const fix = 'export the Scrylux file again from Scrylux and save it unchanged';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [finding('form', file, 'the file is not valid JSON', fix)];
  }

  const findings: Finding[] = [];
  for (const problem of validate(parsed)) findings.push(finding('form', file, `the file breaks the published schema at ${problem}`, fix));
  if (findings.length === 0 && !ScryluxFileV1.safeParse(parsed).success) {
    findings.push(finding('form', file, 'the file breaks the Scrylux file schema of @scrylux/core', fix));
  }
  if (findings.length > 0) return findings;

  // What Scrylux writes for this content: the file read back and written by the real exporter, which fixes the key
  // order, the order of the records and the bytes. (Writing the parsed value again would not do: JSON.parse keeps the
  // order it was given, so a file with its keys shuffled would reproduce itself.)
  const data = parsed as ExchangeFile;
  const written = serializeExport(buildScryluxFile(snapshotOf(data), new Date(data.exported_at)));
  if (written !== text) {
    const why = text.includes('\r\n')
      ? 'the line endings are not "\\n"'
      : !text.endsWith('\n')
        ? 'there is no final newline'
        : 'the key order, the order of the records or the spacing differs';
    findings.push(finding('form', file, `the text is not what Scrylux writes: ${why}`, fix));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// 3, ties

const normal = (name: string): string => name.trim().toLowerCase();
const typeWords = (type: string): string => type.replace('_', ' ');

// An order that only an id could settle changes when an import gives every record a new id, so the round trip and the
// report would differ for a reason that looks like noise (research #2). No two records may tie before the id.
export function checkTies(file: string, data: ExportedFile): Finding[] {
  const fix = 'rename one of them in Scrylux so that they differ, then export again';
  const findings: Finding[] = [];

  const named = new Map<string, string[]>();
  for (const element of data.elements) {
    const key = `${element.type}\0${normal(element.name)}`;
    named.set(key, [...(named.get(key) ?? []), element.name]);
  }
  for (const [key, names] of named) {
    if (names.length > 1) {
      const type = key.split('\0')[0] ?? '';
      findings.push(finding('ties', file, `${names.length} ${typeWords(type)} elements are all named "${names[0]}" (names are compared ignoring case and surrounding space)`, fix));
    }
  }

  const elementName = new Map(data.elements.map((element) => [element.id, element.name]));
  const threats = new Map<string, string[]>();
  for (const threat of data.threats) {
    const key = `${threat.element_id ?? ''}\0${threat.category}\0${normal(threat.title)}`;
    threats.set(key, [...(threats.get(key) ?? []), threat.title]);
  }
  for (const [key, titles] of threats) {
    if (titles.length > 1) {
      const [elementId = '', category = ''] = key.split('\0');
      const where = elementId === '' ? 'the whole model' : `"${elementName.get(elementId) ?? 'an element'}"`;
      findings.push(finding('ties', file, `${titles.length} threats of ${where} share the category ${category} and the title "${titles[0]}"`, fix));
    }
  }

  const threatTitle = new Map(data.threats.map((threat) => [threat.id, threat.title]));
  const mitigations = new Map<string, number>();
  for (const mitigation of data.mitigations) {
    const key = `${mitigation.threat_id}\0${normal(mitigation.description)}`;
    mitigations.set(key, (mitigations.get(key) ?? 0) + 1);
  }
  for (const [key, count] of mitigations) {
    if (count > 1) {
      const threatId = key.split('\0')[0] ?? '';
      findings.push(finding('ties', file, `${count} mitigations of the threat "${threatTitle.get(threatId) ?? 'a threat'}" have one description`, fix));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// 4, shape and folder

const APPROVED_STATUSES: readonly string[] = ['in_review', 'approved'];

export function checkShape(file: string, data: ExportedFile): Finding[] {
  const fix = 'correct it in Scrylux and export both files again';
  const findings: Finding[] = [];
  const add = (message: string): void => {
    findings.push(finding('shape', file, message, fix));
  };

  if (data.project.name !== PROJECT_NAME) add(`the project is named "${data.project.name}", not "${PROJECT_NAME}"`);
  if (data.threat_model.name !== MODEL_NAME) add(`the threat model is named "${data.threat_model.name}", not "${MODEL_NAME}"`);
  const methodology: string = data.threat_model.methodology;
  if (methodology !== 'STRIDE') add(`the methodology is ${methodology}, not STRIDE`);
  if (!APPROVED_STATUSES.includes(data.threat_model.status)) {
    add(`the threat model status is ${data.threat_model.status}; it is committed as in_review or approved`);
  }

  for (const threat of data.threats) {
    if (threat.origin === 'ai') add(`AI-drafted threats are not part of this model: the threat "${threat.title}" has origin ai`);
  }
  for (const category of STRIDE_CATEGORIES) {
    if (!data.threats.some((threat) => threat.category === category)) add(`no threat has the category ${category}`);
  }

  const supported = new Set(data.mitigations.filter((m) => m.status === 'implemented' || m.status === 'verified').map((m) => m.threat_id));
  for (const threat of data.threats) {
    if ((threat.status === 'accepted' || threat.status === 'not_applicable') && (threat.status_reason ?? '').trim() === '') {
      add(`the ${threat.status.replace('_', ' ')} threat "${threat.title}" has no reason`);
    }
    if (threat.status === 'mitigated' && !supported.has(threat.id)) {
      add(`the mitigated threat "${threat.title}" has no implemented or verified mitigation`);
    }
  }

  if (!data.elements.some((element) => element.type === 'trust_boundary')) add('the diagram has no trust boundary');
  if (!data.threats.some((threat) => threat.element_id === null)) add('there is no threat of the whole model, and the pipeline risks need one');
  return findings;
}

// The folder holds the Scrylux file, the report and the README, and nothing else (FR-012).
export function checkFolder(names: readonly string[]): Finding[] {
  const fix = 'keep exactly the three files of docs/threat-model/ and remove the others';
  const findings: Finding[] = [];
  for (const name of names) {
    if (!FOLDER_NAMES.includes(name)) findings.push(finding('folder', `${FOLDER}/`, `the folder holds ${name}, which is not one of its three files`, fix));
  }
  for (const name of FOLDER_NAMES) {
    if (!names.includes(name)) findings.push(finding('folder', `${FOLDER}/`, `the folder is missing ${name}`, fix));
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// 5, patterns

// One finding per pattern per line, naming the line and the pattern and never what matched.
export function checkPatterns(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    for (const { name, pattern, description } of PATTERNS) {
      if (pattern.test(line)) {
        findings.push(finding('patterns', file, `line ${index + 1} holds ${description} (pattern ${name})`, 'reword it in Scrylux so that it holds no credential, personal data or deployment identifier'));
      }
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// 2, the pure half of round-trip

// What an import check says of one file (the `summary` of `POST …/imports/check`), reduced to what the check reads.
export interface SummaryLike {
  models: { name: string; name_issue: string | null; elements: number; threats: number; mitigations: number }[];
  notes: unknown[];
}

// The import accepted the file with nothing left out and the counts it gives are the file's; and the model exported
// after the import is the committed one once ids are mapped to places (`canonical`, which also drops the export time
// and the project name). `again` is the export of the imported model.
export function checkRoundTrip(file: string, summary: SummaryLike, data: ExportedFile, again: ExportedFile): Finding[] {
  const fix = 'import the file into Scrylux, correct what the import reports, and export it again';
  const findings: Finding[] = [];
  const add = (message: string): void => {
    findings.push(finding('round-trip', file, message, fix));
  };

  if (summary.notes.length > 0) add(`the import check lists ${summary.notes.length} thing(s) left out of the model`);
  if (summary.models.length !== 1) {
    add(`the import would create ${summary.models.length} threat models, not 1`);
  } else {
    const [model] = summary.models;
    if (model !== undefined) {
      if (model.name_issue !== null) add(`the import check reports a problem with the threat model name (${model.name_issue})`);
      for (const part of ['elements', 'threats', 'mitigations'] as const) {
        if (model[part] !== data[part].length) add(`the import check counts ${model[part]} ${part}, the file holds ${data[part].length}`);
      }
    }
  }

  const before = canonical(data as unknown as ExchangeFile) as Record<string, unknown>;
  const after = canonical(again as unknown as ExchangeFile) as Record<string, unknown>;
  const differs = ['format', 'format_version', 'threat_model', 'elements', 'threats', 'mitigations'].filter((part) => !isDeepStrictEqual(before[part], after[part]));
  if (differs.length > 0) add(`the model exported after the import differs from the committed file in: ${differs.join(', ')}`);
  return findings;
}

// What the import check answered. A 200 is the summary; anything else is a refusal, whose message is a fixed rule with its
// place in the file (`file.threats.3.status_reason: …`), never a value from the file (Milestone 6, FR-007).
export function checkImportAnswer(file: string, answer: { status: number; body: unknown }): Finding[] {
  if (answer.status === 200) return [];
  const error = typeof answer.body === 'object' && answer.body !== null ? (answer.body as { error?: unknown }).error : undefined;
  const reason = typeof error === 'string' ? error.slice(0, 300) : `status ${answer.status}`;
  return [finding('round-trip', file, `the import check refuses the file: ${reason}`, 'correct it in Scrylux and export it again')];
}

// ---------------------------------------------------------------------------------------------------------------
// 6, what generation says

export interface RegeneratedThreat {
  id: string;
  element_id: string | null;
  title: string;
  origin: string;
  library_ref: string | null;
  stale: unknown;
}

export interface Regeneration {
  file: string;
  // The committed file, as parsed.
  before: ExportedFile;
  // What generation left in the model it ran on (model B): its threats and elements, with ids of their own.
  afterThreats: readonly RegeneratedThreat[];
  afterElements: readonly { id: string; type: string; name: string }[];
  skippedElements: readonly string[];
}

const staleReason = (stale: unknown): string => {
  const reason = typeof stale === 'object' && stale !== null ? (stale as { reason?: unknown }).reason : undefined;
  return typeof reason === 'string' ? reason : 'unknown';
};

// A generated threat is its element and its rule and nothing else (Milestone 3, FR-006), so the two sides are keyed by
// element type, element name and rule, never by id: every id is new after an import. Editing a threat's text, status or
// mitigations is therefore never drift.
//   stale  = generation flagged a threat of the model, or the committed file already carries a stale mark: blocks.
//   behind = generation created a threat the committed model lacks: a warning.
export function classifyRegeneration({ file, before, afterThreats, afterElements, skippedElements }: Regeneration): { stale: Finding[]; behind: Finding[] } {
  const stale: Finding[] = [];
  const behind: Finding[] = [];
  const staleFix = 'import the file into Scrylux, run "Generate threats", review the stale threat, and export both files again';
  const behindFix = 'import the file into Scrylux, run "Generate threats", triage the new threat, and export both files again';

  const beforeElement = new Map(before.elements.map((element) => [element.id, element]));
  const keyOf = (type: string, name: string, ref: string | null): string => `${type}\0${name}\0${ref ?? ''}`;

  const known = new Set<string>();
  for (const threat of before.threats) {
    if (threat.origin !== 'rule' || threat.element_id === null) continue;
    const element = beforeElement.get(threat.element_id);
    if (element === undefined) continue;
    known.add(keyOf(element.type, element.name, threat.library_ref));
    if (threat.stale !== null) {
      stale.push(finding('stale', file, `the committed file already carries a stale mark on the threat "${threat.title}" of "${element.name}" (rule ${threat.library_ref ?? 'none'}): ${staleReason(threat.stale)}`, staleFix));
    }
  }

  const afterElement = new Map(afterElements.map((element) => [element.id, element]));
  for (const threat of afterThreats) {
    if (threat.origin !== 'rule' || threat.element_id === null) continue;
    const element = afterElement.get(threat.element_id);
    if (element === undefined) continue;
    if (threat.stale !== null && threat.stale !== undefined) {
      stale.push(finding('stale', file, `the threat "${threat.title}" on "${element.name}" would be flagged stale: rule ${threat.library_ref ?? 'none'}, ${staleReason(threat.stale)}`, staleFix));
    }
    if (!known.has(keyOf(element.type, element.name, threat.library_ref))) {
      behind.push(finding('behind-rules', file, `rule ${threat.library_ref ?? 'none'} would add "${threat.title}" to "${element.name}"`, behindFix));
    }
  }

  if (skippedElements.length > 0) {
    stale.push(finding('stale', file, `generation skipped ${skippedElements.length} element(s) whose properties the vocabulary does not know`, staleFix));
  }
  return { stale, behind };
}

// ---------------------------------------------------------------------------------------------------------------
// 7, the report

const PROJECT_LINE = '- **Project:** ';
const EXPORTED_LINE = '- **Exported:** ';
const isSetAside = (line: string): boolean => line.startsWith(PROJECT_LINE) || line.startsWith(EXPORTED_LINE);

// The committed report against the one Scrylux builds for the imported model. The project line and the export time are
// set aside (spec FR-015, research #5); every other line must be equal. A difference is named by its line number, never
// quoted. `data` is the committed Scrylux file: the report's title and project line must name what the file names.
export function compareReport(file: string, committed: string, built: string, data: ExportedFile): Finding[] {
  const fix = 'export the report again from the same threat model as the Scrylux file, and save it unchanged';
  const findings: Finding[] = [];
  const add = (message: string): void => {
    findings.push(finding('report', file, message, fix));
  };

  const a = committed.split('\n');
  const b = built.split('\n');
  if (a.length !== b.length) {
    add(`the report has ${a.length} lines, and Scrylux builds ${b.length} for this file`);
  } else {
    const differing = a.map((line, index) => (isSetAside(line) && isSetAside(b[index] ?? '') ? -1 : line === b[index] ? -1 : index)).filter((index) => index >= 0);
    if (differing.length > 0) {
      add(`line ${(differing[0] ?? 0) + 1} differs from the report Scrylux builds for this file (${differing.length} line(s) differ)`);
    }
  }

  if (a[0] !== `# Threat model report: ${markdownInline(data.threat_model.name)}`) add('the title does not name the threat model of the Scrylux file');
  const project = a.find((line) => line.startsWith(PROJECT_LINE));
  if (project !== `${PROJECT_LINE}${markdownInline(data.project.name)}`) add('the project line does not name the project of the Scrylux file');
  if (!committed.includes('```mermaid\n')) add('there is no fenced mermaid diagram');
  return findings;
}
