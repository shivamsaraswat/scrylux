import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import app from '../../src/app.js';
import type { ExportedFile } from '../../src/exchange/scrylux-export.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import {
  checkFolder,
  checkForm,
  checkPatterns,
  checkRoundTrip,
  checkShape,
  checkTies,
  classifyRegeneration,
  compareReport,
  FOLDER,
  formatFinding,
  formatWarning,
  publishedSchemaValidator,
  README_FILE,
  REPORT_FILE,
  SCRYLUX_FILE,
  type Finding,
  type SummaryLike,
} from './checks.js';
import { exportScrylux, importTwice, regenerate, reportMarkdown, session, type Session } from './operations.js';

// Scrylux's own threat model (spec Milestone 7), the committed files held to contracts/checks.md through the real
// operations: the file is imported twice into a scratch project, one model (A) is exported and reported, the other (B)
// is generated against. A missing file is a failure whose message says how to fix it, never a skip: a skipped check would
// let the files be deleted unnoticed (research #13). The committed files are only read, never written.

const DIR = fileURLToPath(new URL('../../../../docs/threat-model/', import.meta.url));
const SCRYLUX_NAME = 'threat-model.scrylux.json';
const REPORT_NAME = 'report.md';
const README_NAME = 'README.md';

const present = (name: string): boolean => existsSync(`${DIR}${name}`);
const needed = (name: string): string => {
  if (!present(name)) {
    throw new Error(
      formatFinding({
        check: 'folder',
        file: `${FOLDER}/${name}`,
        message: 'the file does not exist',
        fix: 'build the model in Scrylux, export the Scrylux file and the Markdown report, and save them unchanged in docs/threat-model/',
      }),
    );
  }
  return readFileSync(`${DIR}${name}`, 'utf8');
};

// A finding fails the test with the two lines the contract gives, so a pull request reader sees exactly them.
const clean = (findings: Finding[]): void => {
  if (findings.length > 0) throw new Error(`\n${findings.map(formatFinding).join('\n\n')}`);
};

const MAX_WARNINGS = 10;

describe('docs/threat-model/', () => {
  let server: TestServer | undefined;
  let s: Session;
  let data: ExportedFile;
  let summary: SummaryLike;
  let exportedAgain: ExportedFile;
  let reportOfA: string;
  let regeneration: Awaited<ReturnType<typeof regenerate>>;

  // Everything that needs the app is done once. With a file missing there is nothing to import, and each test below
  // reports the missing file itself.
  beforeAll(async () => {
    if (!present(SCRYLUX_NAME) || !present(REPORT_NAME)) return;
    data = JSON.parse(needed(SCRYLUX_NAME)) as ExportedFile;
    server = await startTestServer(app);
    s = session(server.baseUrl, await login(server.baseUrl));
    const two = await importTwice(s, data);
    summary = two.summary;
    exportedAgain = await exportScrylux(s, two.a);
    reportOfA = await reportMarkdown(s, two.a);
    regeneration = await regenerate(s, two.b);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it('1 form: is what Scrylux writes, valid against the published schema', () => {
    clean(checkForm(SCRYLUX_FILE, needed(SCRYLUX_NAME), publishedSchemaValidator()));
  });

  it('2 round-trip: imports with nothing left out and exports back to the same model', () => {
    needed(SCRYLUX_NAME);
    clean(checkRoundTrip(SCRYLUX_FILE, summary, data, exportedAgain));
  });

  it('3 ties: no two records an id alone would have to order', () => {
    needed(SCRYLUX_NAME);
    clean(checkTies(SCRYLUX_FILE, data));
  });

  it('4 shape: the project, the model, every STRIDE category, every status supported', () => {
    needed(SCRYLUX_NAME);
    clean(checkShape(SCRYLUX_FILE, data));
  });

  it('4 folder: holds the Scrylux file, the report and the README, and nothing else', () => {
    clean(checkFolder(existsSync(DIR) ? readdirSync(DIR) : []));
  });

  it('5 patterns: no credential, personal data or deployment identifier', () => {
    // Every file is scanned and every finding is reported together; a missing file is reported after them.
    const findings = [...checkPatterns(SCRYLUX_FILE, needed(SCRYLUX_NAME)), ...checkPatterns(REPORT_FILE, needed(REPORT_NAME))];
    let missing: unknown;
    try {
      findings.push(...checkPatterns(README_FILE, needed(README_NAME)));
    } catch (error) {
      missing = error;
    }
    clean(findings);
    if (missing instanceof Error) throw missing;
  });

  it('6a stale: generation flags no threat of the model, and the file carries no stale mark', () => {
    needed(SCRYLUX_NAME);
    clean(classifyRegeneration({ file: SCRYLUX_FILE, before: data, ...regeneration }).stale);
  });

  // Passes whatever it finds: a rule added since the model was made is a warning on the pull request, not a failure
  // (spec FR-016, the clarification of 2026-10-11).
  it('6b behind-rules: warns about each threat the shipped rules would add', async ({ annotate }) => {
    needed(SCRYLUX_NAME);
    const { behind } = classifyRegeneration({ file: SCRYLUX_FILE, before: data, ...regeneration });
    for (const warning of behind.slice(0, MAX_WARNINGS)) await annotate(formatWarning(warning), 'warning');
    if (behind.length > MAX_WARNINGS) {
      await annotate(`Scrylux's own threat model is behind its rules: ${behind.length - MAX_WARNINGS} more threats would be added, after the ${MAX_WARNINGS} above. The build passes.`, 'warning');
    }
  });

  it('7 report: is the report Scrylux builds for this file, with a fenced diagram', () => {
    needed(SCRYLUX_NAME);
    clean(compareReport(REPORT_FILE, needed(REPORT_NAME), reportOfA, data));
  });
});
