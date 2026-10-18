import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryLoadError, loadLibrary, parseLibrary } from '../src/index.js';
import {
  coverageRuleFiles,
  expectIssue,
  files,
  loadIssues,
  replaceFile,
  ruleFile,
  ruleObject,
  ruleYaml,
  validRuleFiles,
} from './helpers.js';

describe('parseLibrary: a valid rule set', () => {
  it('loads one rule of each type, sorted by id', () => {
    const library = parseLibrary(files(...validRuleFiles().reverse()));
    expect(library.rules.map((rule) => rule.id)).toEqual([
      'df-disclosure-test',
      'ds-disclosure-test',
      'ee-spoofing-test',
      'p-tampering-test',
    ]);
    expect(library.retired).toEqual([]);
  });

  it('sorts by code unit, not by locale', () => {
    const set = files(
      ruleFile('process', { id: 'p-b', title: 'b {{element}}' }),
      ruleFile('process', { id: 'p-a10', title: 'a10 {{element}}' }),
      ruleFile('process', { id: 'p-a9', title: 'a9 {{element}}' }),
      ruleFile('process', { id: 'p-a-b', title: 'a-b {{element}}' }),
    );
    expect(parseLibrary(set).rules.map((rule) => rule.id)).toEqual([
      'p-a-b',
      'p-a10',
      'p-a9',
      'p-b',
    ]);
  });

  it('normalises when, references and variant_group', () => {
    const set = files(
      ruleFile('process', { when: undefined, references: undefined, examples: { applies: [{}] } }),
    );
    const [rule] = parseLibrary(set).rules;
    expect(rule?.when).toEqual({ flags: {}, flow: {} });
    expect(rule?.references).toEqual([]);
    expect(rule?.variant_group).toBeNull();
    expect(rule?.examples).toEqual({ applies: [{ flags: {} }], does_not_apply: [] });
  });

  it('reads the data-flow conditions', () => {
    const [rule] = parseLibrary(files(ruleFile('data_flow'))).rules;
    expect(rule?.when).toEqual({
      flags: { encrypted_in_transit: 'no' },
      flow: { crosses_trust_boundary: 'yes' },
    });
  });

  it('freezes what it returns', () => {
    const library = parseLibrary(files(...validRuleFiles()));
    expect(Object.isFrozen(library)).toBe(true);
    expect(Object.isFrozen(library.rules)).toBe(true);
    expect(Object.isFrozen(library.rules[0])).toBe(true);
    expect(Object.isFrozen(library.rules[0]?.mitigations)).toBe(true);
  });
});

describe('parseLibrary: schema issues name the file and the rule', () => {
  const cases: {
    name: string;
    file: ReturnType<typeof ruleFile>;
    rule: string;
    includes: string;
  }[] = [
    {
      name: 'a missing title',
      file: ruleFile('process', { title: undefined }),
      rule: 'p-tampering-test',
      includes: 'title',
    },
    {
      name: 'Spoofing on a data store',
      file: ruleFile('data_store', { category: 'Spoofing' }),
      rule: 'ds-disclosure-test',
      includes: 'category',
    },
    {
      name: 'a data-store flag on a data flow',
      file: ruleFile('data_flow', { when: { flags: { encrypted_at_rest: 'no' } } }),
      rule: 'df-disclosure-test',
      includes: 'when.flags.encrypted_at_rest',
    },
    {
      name: 'a flow condition on a process',
      file: ruleFile('process', { when: { flow: { crosses_trust_boundary: 'yes' } } }),
      rule: 'p-tampering-test',
      includes: 'when.flow',
    },
    {
      name: 'an unknown top-level key',
      file: ruleFile('process', { colour: 'red' }),
      rule: 'p-tampering-test',
      includes: 'colour',
    },
    {
      name: 'a bad likelihood',
      file: ruleFile('process', { likelihood: 'Severe' }),
      rule: 'p-tampering-test',
      includes: 'likelihood',
    },
  ];

  it.each(cases)('$name', ({ file, rule, includes }) => {
    const issues = loadIssues(files(file));
    expectIssue(issues, { file: file.path, rule, includes });
  });

  it('names the offending flag, so a contributor sees the typo', () => {
    const file = ruleFile('process', { when: { flags: { internet_facin: 'yes' } } });
    expectIssue(loadIssues(files(file)), {
      file: file.path,
      rule: 'p-tampering-test',
      includes: 'when.flags.internet_facin: unknown flag',
    });
  });

  it('tells the author to write yes or no when a condition is true or false', () => {
    const file = ruleFile('process');
    const text = file.text.replace('internet_facing: yes', 'internet_facing: true');
    expect(text).not.toBe(file.text);
    expectIssue(loadIssues(files({ ...file, text })), {
      file: file.path,
      rule: 'p-tampering-test',
      includes: 'write yes or no',
    });
  });

  it('uses the file name as the rule when the id is missing', () => {
    const file = { path: 'process/p-no-id.yaml', text: ruleYaml('process', { id: undefined }) };
    expectIssue(loadIssues(files(file)), { file: file.path, rule: 'p-no-id', includes: 'id' });
  });

  it('uses the file name as the rule when the YAML cannot be read', () => {
    const file = { path: 'process/p-broken.yaml', text: 'id: [p-broken\n' };
    expectIssue(loadIssues(files(file)), { file: file.path, rule: 'p-broken', includes: '' });
  });

  it('uses the file name as the rule for an empty file', () => {
    const file = { path: 'process/p-empty.yaml', text: '' };
    expectIssue(loadIssues(files(file)), { file: file.path, rule: 'p-empty', includes: '' });
  });

  it('reports a duplicate key in a rule, naming the rule by its file name', () => {
    const file = ruleFile('process');
    const text = file.text.replace(
      'internet_facing: yes',
      'internet_facing: yes\n    internet_facing: no',
    );
    expectIssue(loadIssues(files({ ...file, text })), {
      file: file.path,
      rule: 'p-tampering-test',
      includes: '',
    });
  });

  it('collects every issue and loads nothing (FR-013)', () => {
    const good = ruleFile('external_entity');
    const bad1 = ruleFile('process', { likelihood: 'Severe' });
    const bad2 = ruleFile('data_store', { impact: undefined });
    let thrown: unknown;
    try {
      parseLibrary(files(good, bad1, bad2));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LibraryLoadError);
    const error = thrown as LibraryLoadError;
    expect(error.issues.map((i) => i.file)).toEqual(expect.arrayContaining([bad1.path, bad2.path]));
    expect(error.issues.every((i) => i.file !== good.path)).toBe(true);
    expect(error.message).toContain(bad1.path);
    expect(error.message).toContain(bad2.path);
  });
});

describe('parseLibrary: the other two files', () => {
  it('reads a retirement record and the registry', () => {
    const retired = {
      path: 'retired.yaml',
      text: 'retired:\n  - id: p-old\n    retired_on: 2026-10-08\n    reason: Split in two.\n    replaced_by: [p-tampering-test]\n',
    };
    const set = files(ruleFile('process'), retired);
    const library = parseLibrary(set);
    expect(library.retired).toEqual([
      {
        id: 'p-old',
        retired_on: '2026-10-08',
        reason: 'Split in two.',
        replaced_by: ['p-tampering-test'],
      },
    ]);
  });

  it('names the entry at fault, not the file, for a bad registry entry', () => {
    const set = replaceFile(
      files(ruleFile('process')),
      'ids.yaml',
      'ids:\n  - Bad_Id\n  - p-tampering-test\n',
    );
    expectIssue(loadIssues(set), { file: 'ids.yaml', rule: 'Bad_Id', includes: 'ids[0]' });
  });

  it('names the record at fault for a bad retirement record', () => {
    const retired = 'retired:\n  - id: p-old\n    retired_on: 2026-02-30\n    reason: Gone.\n';
    const set = replaceFile(files(ruleFile('process')), 'retired.yaml', retired);
    expectIssue(loadIssues(set), { file: 'retired.yaml', rule: 'p-old', includes: 'retired_on' });
  });

  it('gives no rule for a registry that cannot be read at all', () => {
    const set = replaceFile(files(ruleFile('process')), 'ids.yaml', 'ids: [');
    expectIssue(loadIssues(set), { file: 'ids.yaml', rule: null, includes: '' });
  });

  it('ruleObject can remove and replace keys', () => {
    expect(ruleObject('process', { id: undefined })).not.toHaveProperty('id');
    expect(ruleObject('process', { id: 'x' })).toHaveProperty('id', 'x');
  });
});

describe('parseLibrary: file layout (research #2)', () => {
  it('refuses a rule whose file is not named after its id', () => {
    const file = { path: 'process/p-other.yaml', text: ruleYaml('process') };
    expectIssue(loadIssues(files(file)), {
      file: file.path,
      rule: 'p-tampering-test',
      includes: 'must be named p-tampering-test.yaml',
    });
  });

  it('refuses a rule that sits in the directory of another element type', () => {
    const file = { path: 'data_store/p-tampering-test.yaml', text: ruleYaml('process') };
    expectIssue(loadIssues(files(file)), {
      file: file.path,
      rule: 'p-tampering-test',
      includes: 'element_type',
    });
  });

  it('refuses a file ending .yml, so a typo is loud', () => {
    const file = { path: 'process/p-x.yml', text: ruleYaml('process') };
    expectIssue(loadIssues(files(file)), { file: file.path, rule: null, includes: '.yaml' });
  });

  it('refuses a top-level file other than ids.yaml and retired.yaml', () => {
    expectIssue(loadIssues(files({ path: 'notes.yaml', text: 'a: 1\n' })), {
      file: 'notes.yaml',
      rule: null,
      includes: 'top level',
    });
  });

  it('refuses an unknown directory, trust_boundary included', () => {
    for (const directory of ['trust_boundary', 'misc']) {
      const file = { path: `${directory}/x.yaml`, text: ruleYaml('process') };
      expectIssue(loadIssues(files(file)), {
        file: file.path,
        rule: null,
        includes: `unknown directory "${directory}"`,
      });
    }
  });

  it('refuses a nested directory', () => {
    const file = { path: 'process/sub/x.yaml', text: ruleYaml('process') };
    expectIssue(loadIssues(files(file)), { file: file.path, rule: null, includes: 'nested' });
  });

  it('refuses a set with no retired.yaml', () => {
    const set = files(...validRuleFiles()).filter((file) => file.path !== 'retired.yaml');
    expectIssue(loadIssues(set), { file: 'retired.yaml', rule: null, includes: 'missing' });
  });

  it('refuses a set with no ids.yaml', () => {
    const set = files(...validRuleFiles()).filter((file) => file.path !== 'ids.yaml');
    expectIssue(loadIssues(set), { file: 'ids.yaml', rule: null, includes: 'missing' });
  });

  it('does not need a directory for a type that has no rules', () => {
    expect(parseLibrary(files()).rules).toEqual([]);
  });
});

describe('loadLibrary: reading a directory', () => {
  const made: string[] = [];
  const directory = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'scrylux-rules-'));
    made.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('skips names that start with a dot and reads the rest', () => {
    const dir = directory();
    mkdirSync(join(dir, 'process'));
    const rule = ruleFile('process');
    writeFileSync(join(dir, rule.path), rule.text);
    writeFileSync(join(dir, 'ids.yaml'), 'ids:\n  - p-tampering-test\n');
    writeFileSync(join(dir, 'retired.yaml'), 'retired: []\n');
    writeFileSync(join(dir, '.DS_Store'), 'junk');
    writeFileSync(join(dir, 'process', '.hidden.yaml'), 'not: [a rule');
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'config.yaml'), 'x: [');
    const library = loadLibrary(dir, { requireCoverage: false });
    expect(library.rules.map((r) => r.id)).toEqual(['p-tampering-test']);
  });

  it('loads a directory with no type directories but valid ids.yaml and retired.yaml', () => {
    const dir = directory();
    writeFileSync(join(dir, 'ids.yaml'), 'ids: []\n');
    writeFileSync(join(dir, 'retired.yaml'), 'retired: []\n');
    expect(loadLibrary(dir, { requireCoverage: false }).rules).toEqual([]);
  });

  it('reports a stray file it finds on disk', () => {
    const dir = directory();
    writeFileSync(join(dir, 'ids.yaml'), 'ids: []\n');
    writeFileSync(join(dir, 'retired.yaml'), 'retired: []\n');
    writeFileSync(join(dir, 'README.md'), '# hello\n');
    expect(() => loadLibrary(dir, { requireCoverage: false })).toThrow(/README\.md/);
  });

  it('refuses a symbolic link instead of following or skipping it', () => {
    const dir = directory();
    writeFileSync(join(dir, 'ids.yaml'), 'ids: []\n');
    writeFileSync(join(dir, 'retired.yaml'), 'retired: []\n');
    symlinkSync(join(dir, 'ids.yaml'), join(dir, 'link.yaml'));
    expect(() => loadLibrary(dir, { requireCoverage: false })).toThrow(/symbolic link/);
  });
});

describe('parseLibrary: coverage (FR-017)', () => {
  it('names each cell that has no active rule when coverage is required', () => {
    const issues = loadIssues(files(...validRuleFiles()), { requireCoverage: true });
    expectIssue(issues, {
      file: 'rules',
      rule: null,
      includes: 'process / Elevation of Privilege',
    });
    expectIssue(issues, { file: 'rules', rule: null, includes: 'data_flow / Denial of Service' });
  });

  it('does not report the cells that are covered', () => {
    const issues = loadIssues(files(...validRuleFiles()), { requireCoverage: true });
    expect(issues.some((issue) => issue.message.includes('process / Tampering'))).toBe(false);
    expect(
      issues.some((issue) => issue.message.includes('data_flow / Information Disclosure')),
    ).toBe(false);
  });

  it('loads the same set when coverage is not required', () => {
    expect(parseLibrary(files(...validRuleFiles())).rules).toHaveLength(4);
    expect(parseLibrary(files(...validRuleFiles()), { requireCoverage: false }).rules).toHaveLength(
      4,
    );
  });

  it('loads a set with a rule for every cell', () => {
    const library = parseLibrary(files(...coverageRuleFiles()), { requireCoverage: true });
    expect(library.rules).toHaveLength(15);
    expect(library.coverage()).toHaveLength(15);
    expect(library.coverage().every((row) => row.active_rules === 1)).toBe(true);
  });

  it('freezes what coverage returns', () => {
    const rows = parseLibrary(files(...coverageRuleFiles())).coverage();
    expect(Object.isFrozen(rows)).toBe(true);
    expect(rows.every((row) => Object.isFrozen(row))).toBe(true);
  });

  it('lists the cells in STRIDE-per-element order', () => {
    const rows = parseLibrary(files(...coverageRuleFiles())).coverage();
    expect(rows.map((row) => `${row.element_type} / ${row.category}`)).toEqual([
      'external_entity / Spoofing',
      'external_entity / Repudiation',
      'process / Spoofing',
      'process / Tampering',
      'process / Repudiation',
      'process / Information Disclosure',
      'process / Denial of Service',
      'process / Elevation of Privilege',
      'data_store / Tampering',
      'data_store / Repudiation',
      'data_store / Information Disclosure',
      'data_store / Denial of Service',
      'data_flow / Tampering',
      'data_flow / Information Disclosure',
      'data_flow / Denial of Service',
    ]);
  });

  it('does not judge coverage while a rule file is broken', () => {
    const issues = loadIssues(files(ruleFile('process', { likelihood: 'Severe' })), {
      requireCoverage: true,
    });
    expect(issues.some((issue) => issue.file === 'rules')).toBe(false);
  });
});
