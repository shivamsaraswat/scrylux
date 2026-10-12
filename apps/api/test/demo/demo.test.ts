import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, it } from 'vitest';
import app from '../../src/app.js';
import type { ExportedFile } from '../../src/exchange/specter-export.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import {
  checkForm,
  checkPatterns,
  checkRoundTrip,
  checkTies,
  classifyRegeneration,
  publishedSchemaValidator,
  type Finding,
  type SummaryLike,
} from '../dogfood/checks.js';
import { exportSpecter, importTwice, regenerate, session, type Session } from '../dogfood/operations.js';
import {
  checkDemoFolder,
  checkDemoShape,
  DEMO_FILE,
  DEMO_FOLDER,
  formatDemoFinding,
  formatDemoWarning,
  withoutLoopback,
} from './checks.js';

// The demo threat model (spec Milestone 8, FR-023 to FR-026), the committed file held to contracts/checks.md D1 to D7 through
// the real operations, as Milestone 7 holds Specter's own model: the file is imported twice into a scratch project, one model
// (A) is exported, the other (B) is generated against. A missing file is a failure whose message says how to fix it, never a
// skip: a skipped check would let the files be deleted unnoticed (Milestone 7, research #13). The committed files are only read.

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DIR = `${ROOT}${DEMO_FOLDER}/`;
const FILE_NAME = 'notes-app.specter.json';
const README_NAME = 'README.md';

const present = (name: string): boolean => existsSync(`${DIR}${name}`);
const needed = (name: string): string => {
  if (!present(name)) {
    throw new Error(
      formatDemoFinding({
        check: 'folder',
        file: `${DEMO_FOLDER}/${name}`,
        message: 'the file does not exist',
        fix: 'author the demo in Specter, export it unchanged, and write its description',
      }),
    );
  }
  return readFileSync(`${DIR}${name}`, 'utf8');
};

// A finding fails the test with the two lines of the contract, so a pull request reader sees exactly them.
const clean = (findings: Finding[]): void => {
  if (findings.length > 0) throw new Error(`\n${findings.map(formatDemoFinding).join('\n\n')}`);
};

// The text files this milestone adds that are scanned with the demo (FR-043). A deleted one fails the check; none is skipped.
const SCANNED = ['CHANGELOG.md', 'docs/releasing.md', 'docker-compose.release.yml'];

const MAX_WARNINGS = 10;

describe('docs/demo/', () => {
  let server: TestServer | undefined;
  let s: Session;
  let data: ExportedFile;
  let summary: SummaryLike;
  let exportedAgain: ExportedFile;
  let regeneration: Awaited<ReturnType<typeof regenerate>>;

  // Everything that needs the app is done once. With the file missing there is nothing to import, and each test below
  // reports the missing file itself.
  beforeAll(async () => {
    if (!present(FILE_NAME)) return;
    data = JSON.parse(needed(FILE_NAME)) as ExportedFile;
    server = await startTestServer(app);
    s = session(server.baseUrl, await login(server.baseUrl));
    const two = await importTwice(s, data);
    summary = two.summary;
    exportedAgain = await exportSpecter(s, two.a);
    regeneration = await regenerate(s, two.b);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it('D1 form: is what Specter writes, valid against the published schema', () => {
    clean(checkForm(DEMO_FILE, needed(FILE_NAME), publishedSchemaValidator()));
  });

  it('D2 round-trip: imports with nothing left out and exports back to the same model', () => {
    needed(FILE_NAME);
    clean(checkRoundTrip(DEMO_FILE, summary, data, exportedAgain));
  });

  it('D3 ties: no two records an id alone would have to order', () => {
    needed(FILE_NAME);
    clean(checkTies(DEMO_FILE, data));
  });

  it('D4 shape: everything the demo is to show, and nothing AI-drafted', () => {
    needed(FILE_NAME);
    clean(checkDemoShape(DEMO_FILE, data));
  });

  it('D6 folder: holds the demo and its description, and nothing else', () => {
    clean(checkDemoFolder(existsSync(DIR) ? readdirSync(DIR) : []));
  });

  it('D7 patterns: no credential, personal data or deployment identifier in the demo or the release text', () => {
    // Every file is scanned and every finding is reported together; a missing file is reported after them.
    const findings: Finding[] = [];
    let missing: unknown;
    const scan = (relative: string, text: string): void => {
      findings.push(...checkPatterns(relative, withoutLoopback(text)));
    };
    for (const name of [FILE_NAME, README_NAME]) {
      try {
        scan(`${DEMO_FOLDER}/${name}`, needed(name));
      } catch (error) {
        missing ??= error;
      }
    }
    for (const relative of SCANNED) {
      const path = `${ROOT}${relative}`;
      if (existsSync(path)) scan(relative, readFileSync(path, 'utf8'));
      else missing ??= new Error(formatDemoFinding({ check: 'patterns', file: relative, message: 'the file does not exist', fix: `restore ${relative}, which this milestone adds` }));
    }
    clean(findings);
    if (missing instanceof Error) throw missing;
  });

  it('D5 stale: generation flags no threat of the demo, and the file carries no stale mark', () => {
    needed(FILE_NAME);
    clean(classifyRegeneration({ file: DEMO_FILE, before: data, ...regeneration }).stale);
  });

  // Passes whatever it finds: a rule added since the demo was made is a warning on the pull request, not a failure
  // (spec FR-026).
  it('D5 behind-rules: warns about each threat the shipped rules would add', async ({ annotate }) => {
    needed(FILE_NAME);
    const { behind } = classifyRegeneration({ file: DEMO_FILE, before: data, ...regeneration });
    for (const warning of behind.slice(0, MAX_WARNINGS)) await annotate(formatDemoWarning(warning), 'warning');
    if (behind.length > MAX_WARNINGS) {
      await annotate(`The demo threat model is behind the rules: ${behind.length - MAX_WARNINGS} more threats would be added, after the ${MAX_WARNINGS} above. The build passes.`, 'warning');
    }
  });
});
