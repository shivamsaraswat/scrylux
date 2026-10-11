import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/app.js';
import { buildSpecterFile, serializeExport, type ExportedFile } from '../../src/exchange/specter-export.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { buildReport } from '../../src/report/model.js';
import { login, startTestServer, type TestServer } from '../contract/helpers.js';
import { seedUs1Model } from '../contract/v1/exchange-helpers.js';
import { us1Model, snapshotOf, withIds, type ExchangeFile } from '../exchange/fixtures.js';
import {
  checkFolder,
  checkForm,
  checkImportAnswer,
  checkPatterns,
  checkRoundTrip,
  checkShape,
  checkTies,
  classifyRegeneration,
  compareReport,
  formatFinding,
  publishedSchemaValidator,
  type Finding,
} from './checks.js';
import {
  checkImport,
  exportSpecter,
  importModel,
  importTwice,
  newProject,
  regenerate,
  reportMarkdown,
  session,
  type Session,
} from './operations.js';
import { PATTERNS } from './patterns.js';

// The checks of contracts/checks.md as pure functions, each shown to fail on an input made to break it. They read no
// committed file and call no operation: the operations are in the second half of this file and in threat-model.test.ts.

const FILE = 'docs/threat-model/threat-model.specter.json';
const AT = new Date('2026-10-11T09:30:00.000Z');

const exported = (file: ExchangeFile): ExportedFile => buildSpecterFile(snapshotOf(file), AT);
const textOf = (file: ExchangeFile): string => serializeExport(exported(file));

// A file that satisfies every rule of check 4, made from Milestone 6's seeded model: the two threats a user could not
// create (an accepted one with no reason, a mitigated one with no implemented mitigation) are completed.
function goodFile(): ExchangeFile {
  const file = us1Model();
  file.project.name = 'Specter';
  file.threat_model.name = 'Specter application';
  file.threats = file.threats.map((threat) => {
    if (threat.id === 't-man-acc-noreason') return { ...threat, status_reason: 'Accepted until the roles of Phase 6' };
    if (threat.id === 't-rule-2') return { ...threat, stale: null };
    return threat;
  });
  file.mitigations = file.mitigations.map((m) => (m.id === 'm-3' ? { ...m, status: 'implemented' as const } : m));
  return file;
}

const checks = (findings: Finding[]): string[] => findings.map((finding) => finding.check);

describe('formatFinding', () => {
  it('writes two lines: the file, the check and what is wrong, then the fix and where to read about it', () => {
    const text = formatFinding({ check: 'ties', file: FILE, message: 'two processes are both named "API"', fix: 'rename one of them in Specter' });
    expect(text).toBe(
      `${FILE}: ties: two processes are both named "API".\nFix: rename one of them in Specter. See "Updating the model" in docs/threat-model/README.md.`,
    );
  });
});

describe('check 1, form', () => {
  const validate = publishedSchemaValidator();

  it('passes the text Specter writes', () => {
    expect(checkForm(FILE, textOf(goodFile()), validate)).toEqual([]);
  });

  it('fails text that is not JSON', () => {
    const findings = checkForm(FILE, '{ not json', validate);
    expect(checks(findings)).toEqual(['form']);
    expect(findings[0]?.message).toContain('not valid JSON');
  });

  it('fails keys in another order', () => {
    const file = exported(goodFile());
    const reordered = { threat_model: file.threat_model, format: file.format, format_version: file.format_version, exported_at: file.exported_at, project: file.project, elements: file.elements, threats: file.threats, mitigations: file.mitigations };
    const findings = checkForm(FILE, serializeExport(reordered), validate);
    expect(checks(findings)).toEqual(['form']);
    expect(findings[0]?.message).toContain('not what Specter writes');
  });

  it('fails Windows line endings', () => {
    const findings = checkForm(FILE, textOf(goodFile()).replace(/\n/g, '\r\n'), validate);
    expect(checks(findings)).toEqual(['form']);
    expect(findings[0]?.message).toContain('line endings');
  });

  it('fails a missing final newline', () => {
    const findings = checkForm(FILE, textOf(goodFile()).trimEnd(), validate);
    expect(checks(findings)).toEqual(['form']);
    expect(findings[0]?.message).toContain('final newline');
  });

  it('fails a file that breaks the schema, with the place in the file and never the value', () => {
    const file = exported(goodFile());
    const broken = { ...file, threats: file.threats.map((threat, index) => (index === 0 ? { ...threat, status: 'on_fire' } : threat)) };
    const findings = checkForm(FILE, serializeExport(broken), validate);
    expect(checks(findings)).toContain('form');
    const message = findings.map((finding) => finding.message).join('\n');
    expect(message).toContain('threats');
    expect(message).not.toContain('on_fire');
  });
});

describe('check 3, ties', () => {
  it('passes the same name on different element types and the same title in different categories', () => {
    const file = goodFile();
    file.elements.push({ id: 'p-dup-api', type: 'data_store', name: 'API', properties: {}, layout: null, parent_boundary_id: null, source_element_id: null, target_element_id: null });
    expect(checkTies(FILE, exported(file))).toEqual([]);
  });

  it('fails two elements of one type named alike, ignoring case and surrounding space', () => {
    const file = goodFile();
    file.elements.push({ id: 'p-dup', type: 'process', name: '  api ', properties: {}, layout: null, parent_boundary_id: null, source_element_id: null, target_element_id: null });
    const findings = checkTies(FILE, exported(file));
    expect(checks(findings)).toEqual(['ties']);
    expect(findings[0]?.message).toContain('process');
  });

  it('fails two threats of one element with one category and title', () => {
    const file = goodFile();
    const first = file.threats.find((threat) => threat.id === 't-man-acc');
    if (first === undefined) throw new Error('fixture changed');
    file.threats.push({ ...first, id: 't-twin', description: 'another description' });
    const findings = checkTies(FILE, exported(file));
    expect(checks(findings)).toEqual(['ties']);
    expect(findings[0]?.message).toContain('No audit trail');
    expect(findings[0]?.message).not.toContain('another description');
  });

  it('fails two threats of no element with one category and title', () => {
    const file = goodFile();
    const first = file.threats.find((threat) => threat.id === 't-model-1');
    if (first === undefined) throw new Error('fixture changed');
    file.threats.push({ ...first, id: 't-model-twin' });
    expect(checks(checkTies(FILE, exported(file)))).toEqual(['ties']);
  });

  it('fails two mitigations of one threat with one description', () => {
    const file = goodFile();
    file.mitigations.push({ id: 'm-twin', threat_id: 't-rule-1', description: 'Require MFA', status: 'proposed', external_ref: null });
    expect(checks(checkTies(FILE, exported(file)))).toEqual(['ties']);
  });
});

describe('check 4, shape', () => {
  const problems = (change: (file: ExchangeFile) => void): string[] => {
    const file = goodFile();
    change(file);
    return checkShape(FILE, exported(file)).map((finding) => finding.message);
  };

  it('passes a file that satisfies every rule', () => {
    expect(checkShape(FILE, exported(goodFile()))).toEqual([]);
  });

  it('fails a project that is not named Specter, and a threat model that is not named Specter application', () => {
    expect(problems((file) => (file.project.name = 'Payments')).join('\n')).toContain('project');
    expect(problems((file) => (file.threat_model.name = 'Checkout')).join('\n')).toContain('threat model is named');
  });

  it('fails another methodology and a status outside in_review and approved', () => {
    expect(problems((file) => (file.threat_model.methodology = 'LINDDUN' as never)).join('\n')).toContain('methodology');
    expect(problems((file) => (file.threat_model.status = 'draft')).join('\n')).toContain('status');
  });

  it('passes in_review and approved', () => {
    expect(problems((file) => (file.threat_model.status = 'approved'))).toEqual([]);
  });

  it('fails a threat of origin ai', () => {
    expect(problems((file) => (file.threats[0] = { ...(file.threats[0] as ExchangeFile['threats'][number]), origin: 'ai' })).join('\n')).toContain('AI');
  });

  it.each(['Spoofing', 'Tampering', 'Repudiation', 'Information Disclosure', 'Denial of Service', 'Elevation of Privilege'] as const)(
    'fails a model with no %s threat',
    (category) => {
      const found = problems((file) => {
        const gone = new Set(file.threats.filter((threat) => threat.category === category).map((threat) => threat.id));
        file.threats = file.threats.filter((threat) => !gone.has(threat.id));
        file.mitigations = file.mitigations.filter((m) => !gone.has(m.threat_id));
      });
      expect(found.join('\n')).toContain(category);
    },
  );

  it('fails an accepted or not applicable threat with no reason', () => {
    const found = problems((file) => {
      file.threats = file.threats.map((threat) => (threat.id === 't-man-acc' ? { ...threat, status_reason: null } : threat));
    });
    expect(found.join('\n')).toContain('No audit trail');
    const blank = problems((file) => {
      file.threats = file.threats.map((threat) => (threat.id === 't-man-na' ? { ...threat, status_reason: '   ' } : threat));
    });
    expect(blank.join('\n')).toContain('Disk fills up');
  });

  it('fails a mitigated threat whose only mitigation is proposed', () => {
    const found = problems((file) => {
      file.mitigations = file.mitigations.map((m) => (m.id === 'm-3' ? { ...m, status: 'proposed' as const } : m));
    });
    expect(found.join('\n')).toContain('Batch input is not checked');
  });

  it('fails a model with no trust boundary, and one with no threat of the whole model', () => {
    const noBoundary = problems((file) => {
      file.threats = file.threats.filter((threat) => threat.element_id !== 'b-internal');
      file.elements = file.elements.filter((element) => element.type !== 'trust_boundary');
    });
    expect(noBoundary.join('\n')).toContain('trust boundary');
    const noModelThreat = problems((file) => {
      file.threats = file.threats.filter((threat) => threat.element_id !== null);
    });
    expect(noModelThreat.join('\n')).toContain('whole model');
  });

  it('never quotes a description or a reason', () => {
    const file = goodFile();
    file.threats = file.threats.map((threat) => (threat.id === 't-man-acc' ? { ...threat, status: 'open', status_reason: null, description: 'SECRET-DESCRIPTION' } : threat));
    file.mitigations = [];
    const found = checkShape(FILE, exported(file)).map((finding) => finding.message).join('\n');
    expect(found).not.toContain('SECRET-DESCRIPTION');
  });
});

describe('check 4, folder', () => {
  const THREE = ['README.md', 'report.md', 'threat-model.specter.json'];

  it('passes exactly the three files, in any order', () => {
    expect(checkFolder([...THREE].reverse())).toEqual([]);
  });

  it.each(['threat-model.otm.json', 'report.html', 'build.sh', 'diagram.png'])('fails an extra file, %s, and names it', (extra) => {
    const findings = checkFolder([...THREE, extra]);
    expect(checks(findings)).toEqual(['folder']);
    expect(findings[0]?.message).toContain(extra);
  });

  it('fails a missing file, and names it', () => {
    const findings = checkFolder(THREE.filter((name) => name !== 'report.md'));
    expect(checks(findings)).toEqual(['folder']);
    expect(findings[0]?.message).toContain('report.md');
  });
});

// One sample that must match and one near-miss that must not, for every pattern, written as text of the JSON file.
// The table is checked both ways, so a pattern added without a sample fails here, and a sample with no pattern too.
const SAMPLES: Record<string, { hit: string; miss: string }> = {
  email: { hit: '"description": "Write to someone@example.org about it"', miss: '"description": "The @specter/api package"' },
  ipv4: { hit: '"title": "Reaches 10.0.12.34 inside"', miss: '"title": "Node.js 22.1.0 or newer"' },
  'account-id': { hit: '"title": "Account 123456789012 owns the role"', miss: '"id": "0b9c4a1e-7d2f-4c3a-8e5b-123456789012"' },
  'aws-access-key': { hit: '"description": "Key AKIAIOSFODNN7EXAMPLE leaked"', miss: '"description": "Keys begin with AKIA and are 20 characters"' },
  jwt: { hit: '"description": "Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl used"', miss: '"description": "A JWT has three parts"' },
  bearer: { hit: '"description": "Header Bearer abcdefghijklmnopqrstuvwxyz0123 sent"', miss: '"description": "Send the Bearer token in the header"' },
  'private-key': { hit: '"description": "-----BEGIN RSA PRIVATE KEY----- pasted"', miss: '"description": "Private keys are never stored"' },
  'github-token': { hit: '"description": "ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123 pasted"', miss: '"description": "Tokens start with ghp_ and are long"' },
  'secret-assignment': { hit: '"description": "Set JWT_SECRET=hunter2hunter2 in the file"', miss: '"description": "The token is held in memory only and the secret comes from the environment"' },
};

describe('check 5, patterns', () => {
  it('has a sample for every pattern and a pattern for every sample', () => {
    expect(PATTERNS.map((pattern) => pattern.name).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(Object.keys(SAMPLES))('%s matches its sample and not its near-miss', (name) => {
    const sample = SAMPLES[name];
    if (sample === undefined) throw new Error('no sample');
    const hit = checkPatterns(FILE, sample.hit);
    expect(hit.map((finding) => finding.message).join('\n')).toContain(name);
    expect(checkPatterns(FILE, sample.miss)).toEqual([]);
  });

  it('reports the line, never the text it matched', () => {
    const findings = checkPatterns(FILE, 'fine\nWrite to someone@example.org\nfine');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('line 2');
    expect(findings[0]?.message).not.toContain('someone@example.org');
  });

  it('does not match the file Specter writes for a model with ids that end in twelve digits', () => {
    const file = goodFile();
    file.elements[0] = { ...(file.elements[0] as ExchangeFile['elements'][number]), id: '0b9c4a1e-7d2f-4c3a-8e5b-123456789012' };
    file.threats = file.threats.map((threat) => (threat.element_id === 'b-internal' ? { ...threat, element_id: '0b9c4a1e-7d2f-4c3a-8e5b-123456789012' } : threat));
    file.elements = file.elements.map((element) => (element.parent_boundary_id === 'b-internal' ? { ...element, parent_boundary_id: '0b9c4a1e-7d2f-4c3a-8e5b-123456789012' } : element));
    expect(checkPatterns(FILE, textOf(file))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Check 2, the pure half of round-trip

describe('check 2, checkRoundTrip', () => {
  const good = exported(goodFile());
  const summaryOf = (file: ExportedFile) => ({
    models: [{ name: file.threat_model.name, name_issue: null as string | null, elements: file.elements.length, threats: file.threats.length, mitigations: file.mitigations.length }],
    notes: [] as unknown[],
  });
  // The same model after an import and an export: every id is new, the export time and the project name differ.
  const again = (change: (file: ExchangeFile) => void = () => undefined): ExportedFile => {
    const file = withIds(goodFile(), (id) => `new-${id}`);
    file.project.name = 'Scratch project';
    file.exported_at = '2026-10-12T00:00:00.000Z';
    change(file);
    return exported(file);
  };

  it('passes a model that came back with new ids, another export time and another project name', () => {
    expect(checkRoundTrip(FILE, summaryOf(good), good, again())).toEqual([]);
  });

  it('fails a summary with a note, a name issue, another number of models or a wrong count', () => {
    const noted = { ...summaryOf(good), notes: [{ kind: 'x' }] };
    expect(checkRoundTrip(FILE, noted, good, again()).map((f) => f.message).join('\n')).toContain('left out');
    const issue = summaryOf(good);
    (issue.models[0] as { name_issue: string | null }).name_issue = 'taken';
    expect(checkRoundTrip(FILE, issue, good, again()).map((f) => f.message).join('\n')).toContain('name');
    const two = { models: [...summaryOf(good).models, ...summaryOf(good).models], notes: [] };
    expect(checkRoundTrip(FILE, two, good, again()).map((f) => f.message).join('\n')).toContain('2 threat models');
    const counts = summaryOf(good);
    (counts.models[0] as { threats: number }).threats += 1;
    expect(checkRoundTrip(FILE, counts, good, again()).map((f) => f.message).join('\n')).toContain('threats');
  });

  it('fails a model that differs after the round trip, naming the part and not the content', () => {
    const changed = again((file) => {
      file.threats = file.threats.map((threat) => (threat.id.endsWith('t-man-na') ? { ...threat, status: 'open', status_reason: null } : threat));
    });
    const findings = checkRoundTrip(FILE, summaryOf(good), good, changed);
    expect(checks(findings)).toEqual(['round-trip']);
    expect(findings[0]?.message).toContain('threats');
    expect(findings[0]?.message).not.toContain('Disk fills up');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Check 6, what generation says

describe('check 6, classifyRegeneration', () => {
  const before = exported(goodFile());
  // What the model looks like after "Generate threats" on an import of it: new ids, the same rule threats.
  const regenerate = (change: (threats: Record<string, unknown>[]) => Record<string, unknown>[] = (t) => t) => {
    const renamed = withIds(goodFile(), (id) => `new-${id}`);
    const after = exported(renamed);
    return {
      afterElements: after.elements.map(({ id, type, name }) => ({ id, type, name })),
      afterThreats: change(after.threats as unknown as Record<string, unknown>[]) as unknown as ExportedFile['threats'],
    };
  };
  const run = (after: ReturnType<typeof regenerate>, skipped: string[] = [], file: ExportedFile = before) =>
    classifyRegeneration({ file: FILE, before: file, skippedElements: skipped, ...after });

  it('finds nothing when generation changes nothing, even though every id is new', () => {
    expect(run(regenerate())).toEqual({ stale: [], behind: [] });
  });

  it('does not count an edited title, status, reason or mitigation as drift: a rule threat is its element and its rule', () => {
    const edited = regenerate((threats) => threats.map((threat) => (threat.origin === 'rule' ? { ...threat, title: 'Another title', status: 'accepted', status_reason: 'r' } : threat)));
    expect(run(edited)).toEqual({ stale: [], behind: [] });
  });

  it('blocks a threat that carries a stale mark after the run, naming the threat, the element, the rule and the reason', () => {
    const stale = regenerate((threats) => threats.map((threat) => (threat.library_ref === 'process-spoofing' ? { ...threat, stale: { reason: 'rule_retired' } } : threat)));
    const { stale: found, behind } = run(stale);
    expect(behind).toEqual([]);
    expect(checks(found)).toEqual(['stale']);
    expect(found[0]?.message).toContain('Spoofing of API');
    expect(found[0]?.message).toContain('"API"');
    expect(found[0]?.message).toContain('process-spoofing');
    expect(found[0]?.message).toContain('rule_retired');
  });

  it('blocks a committed file that already carries a stale mark', () => {
    const marked = exported(us1Model());
    const { stale } = classifyRegeneration({ file: FILE, before: marked, skippedElements: [], afterElements: [], afterThreats: [] });
    expect(stale.map((f) => f.message).join('\n')).toContain('already carries a stale mark');
  });

  it('warns about a rule threat generation created, naming the rule and the element', () => {
    const more = regenerate((threats) => [
      ...threats,
      { ...(threats.find((threat) => threat.origin === 'rule') as Record<string, unknown>), id: 'extra', library_ref: 'process-new-rule', title: 'A new threat', element_id: 'new-p-batch' },
    ]);
    const { stale, behind } = run(more);
    expect(stale).toEqual([]);
    expect(checks(behind)).toEqual(['behind-rules']);
    expect(behind[0]?.message).toContain('process-new-rule');
    expect(behind[0]?.message).toContain('"Batch"');
    expect(behind[0]?.message).toContain('A new threat');
  });

  it('ignores a manual threat', () => {
    const manual = regenerate((threats) => [...threats, { ...(threats.find((threat) => threat.origin === 'manual') as Record<string, unknown>), id: 'extra', title: 'Manual extra' }]);
    expect(run(manual)).toEqual({ stale: [], behind: [] });
  });

  it('blocks when generation skipped an element, because the model then holds properties the vocabulary does not know', () => {
    const { stale } = run(regenerate(), ['new-p-api']);
    expect(checks(stale)).toEqual(['stale']);
    expect(stale[0]?.message).toContain('skipped');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Check 7, the report

describe('check 7, compareReport', () => {
  const T1 = new Date('2026-10-11T09:30:00.000Z');
  const T2 = new Date('2026-10-13T17:05:00.000Z');
  const reportOf = (file: ExchangeFile, at: Date): string => renderMarkdown(buildReport(snapshotOf(file), at));
  const data = exported(goodFile());
  const committed = reportOf(goodFile(), T1);
  // What the operation builds for the scratch import: another project, another instant.
  const built = reportOf({ ...goodFile(), project: { name: 'Scratch project 7' } }, T2);

  it('passes two reports that differ only in the project line and the export time', () => {
    expect(committed).not.toBe(built);
    expect(compareReport(FILE, committed, built, data)).toEqual([]);
  });

  it('fails one changed line, naming its number and never its text', () => {
    const lines = committed.split('\n');
    const at = lines.findIndex((line) => line.startsWith('## Elements')) + 2;
    lines[at] = `${lines[at]} CHANGED-BY-HAND`;
    const findings = compareReport(FILE, lines.join('\n'), built, data);
    expect(checks(findings)).toEqual(['report']);
    expect(findings[0]?.message).toContain(`line ${at + 1}`);
    expect(findings[0]?.message).not.toContain('CHANGED-BY-HAND');
  });

  it('fails a report with a different number of lines', () => {
    const findings = compareReport(FILE, `${committed}\nan extra line\n`, built, data);
    expect(findings.map((f) => f.message).join('\n')).toContain('lines');
  });

  it('fails a committed report whose project line names another project than the Specter file', () => {
    const other = reportOf({ ...goodFile(), project: { name: 'Another project' } }, T1);
    const findings = compareReport(FILE, other, built, data);
    expect(findings.map((f) => f.message).join('\n')).toContain('project line');
  });

  it('fails a committed report whose title names another threat model', () => {
    const other = reportOf({ ...goodFile(), threat_model: { ...goodFile().threat_model, name: 'Another model' } }, T1);
    expect(compareReport(FILE, other, built, data).map((f) => f.message).join('\n')).toContain('title');
  });

  it('fails a committed report with no fenced mermaid diagram', () => {
    const without = committed.replace('```mermaid', '```text');
    expect(compareReport(FILE, without, built, data).map((f) => f.message).join('\n')).toContain('diagram');
  });

  it('does not accept a report with the project line and the export line missing', () => {
    const stripped = committed.split('\n').filter((line) => !line.startsWith('- **Project:**') && !line.startsWith('- **Exported:**')).join('\n');
    expect(compareReport(FILE, stripped, built, data).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Checks 2, 6 and 7 through the real operations

describe('the checks through the operations', () => {
  let server: TestServer;
  let s: Session;
  let seededModelId: string;

  // The model of Milestone 6's seed, as the API holds it: generated threats (one with a stale mark), manual threats in
  // every status, a threat of the whole model. An explicit timeout: heavy transactions have stalled this suite before
  // (commit 23c5990), and the default 5 s is not a contract.
  beforeAll(async () => {
    server = await startTestServer(app);
    s = session(server.baseUrl, await login(server.baseUrl));
    seededModelId = (await seedUs1Model(s.c)).modelId;
  }, 60_000);

  afterAll(async () => {
    await server.close();
  });

  const withoutRuleThreats = (data: ExportedFile): ExportedFile => {
    const gone = new Set(data.threats.filter((threat) => threat.origin === 'rule').map((threat) => threat.id));
    return { ...data, threats: data.threats.filter((threat) => !gone.has(threat.id)), mitigations: data.mitigations.filter((m) => !gone.has(m.threat_id)) };
  };
  // Generation run on an import of `data`, and what it left: the input of classifyRegeneration.
  const regenerationOf = async (data: ExportedFile) => {
    const modelId = await importModel(s, await newProject(s), data);
    return regenerate(s, modelId);
  };

  describe('check 2, the refusal of an import', () => {
    it('is reported with its place in the file when a threat has origin ai', async () => {
      const bad = exported(goodFile());
      bad.threats[0] = { ...(bad.threats[0] as ExportedFile['threats'][number]), origin: 'ai' };
      const findings = checkImportAnswer(FILE, await checkImport(s, await newProject(s), bad));
      expect(checks(findings)).toEqual(['round-trip']);
      expect(findings[0]?.message).toContain('file.threats.0.origin');
    });

    it('is reported when a data flow has no target', async () => {
      const bad = exported(goodFile());
      bad.elements = bad.elements.map((element) => (element.type === 'data_flow' ? { ...element, target_element_id: null } : element));
      const findings = checkImportAnswer(FILE, await checkImport(s, await newProject(s), bad));
      expect(checks(findings)).toEqual(['round-trip']);
      expect(findings[0]?.message).toContain('file.elements');
    });

    it('is no finding when the file is accepted', async () => {
      const answer = await checkImport(s, await newProject(s), exported(goodFile()));
      expect(answer.status).toBe(200);
      expect(checkImportAnswer(FILE, answer)).toEqual([]);
    });
  });

  describe('check 6, stale and behind the rules', () => {
    it('blocks a committed file that carries a stale mark (the seeded model has one)', async () => {
      const data = await exportSpecter(s, seededModelId);
      expect(data.threats.some((threat) => threat.stale !== null)).toBe(true);
      const { stale } = classifyRegeneration({ file: FILE, before: data, ...(await regenerationOf(data)) });
      expect(stale.length).toBeGreaterThan(0);
      expect(stale.map((f) => f.message).join('\n')).toContain('stale');
    });

    it('warns, and does not block, when the diagram has no generated threats yet', async () => {
      const data = withoutRuleThreats(await exportSpecter(s, seededModelId));
      const { stale, behind } = classifyRegeneration({ file: FILE, before: data, ...(await regenerationOf(data)) });
      expect(stale).toEqual([]);
      expect(behind.length).toBeGreaterThan(0);
      expect(checks(behind)).toEqual(behind.map(() => 'behind-rules'));
    });

    it('says nothing about a model that was generated and is unchanged', async () => {
      const exportedModel = await exportSpecter(s, seededModelId);
      const data = { ...exportedModel, threats: exportedModel.threats.map((threat) => ({ ...threat, stale: null })) };
      expect(classifyRegeneration({ file: FILE, before: data, ...(await regenerationOf(data)) })).toEqual({ stale: [], behind: [] });
    });
  });

  // The case the clarification chose to warn on: the rules would add threats the committed model lacks. With the file
  // imported twice, model A never generated against and model B generated against, checks 2 and 7 pass on A and 6b warns
  // on B. Run on one shared model the same case would fail checks 2 and 7, which is why the arrangement is a requirement.
  describe('checks 2, 6b and 7 together', () => {
    it('pass on model A and warn on model B when the model is behind the rules', async () => {
      const seeded = withoutRuleThreats(await exportSpecter(s, seededModelId));
      const x = await importModel(s, await newProject(s), seeded);
      // What a committed pair would be: the export and the report of one model, taken back to back.
      const committed = await exportSpecter(s, x);
      const committedReport = await reportMarkdown(s, x);

      const two = await importTwice(s, committed);
      expect(two.summary.models).toHaveLength(1);
      expect(checkRoundTrip(FILE, two.summary, committed, await exportSpecter(s, two.a))).toEqual([]);
      expect(compareReport(FILE, committedReport, await reportMarkdown(s, two.a), committed)).toEqual([]);

      const { stale, behind } = classifyRegeneration({ file: FILE, before: committed, ...(await regenerate(s, two.b)) });
      expect(stale).toEqual([]);
      expect(behind.length).toBeGreaterThan(0);

      // On one shared model the same case fails check 2: generation put its threats in the export.
      await regenerate(s, two.a);
      expect(checkRoundTrip(FILE, two.summary, committed, await exportSpecter(s, two.a)).length).toBeGreaterThan(0);
    });
  });
});
