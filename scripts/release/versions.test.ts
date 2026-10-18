import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkLabels,
  checkVersions,
  compareFinal,
  composeDefaultVersion,
  expectedLabels,
  findChangelogEntry,
  formatFinding,
  labelArgs,
  packagesAgree,
  parseTag,
  pinComposeVersion,
} from './versions.js';

// The contract is specs/phase-2/milestone-8-release-v0-1/contracts/release-artifacts.md ("The version", "The image",
// "The release compose file") and data-model.md §1 ("Version"). These are the pure rules: no file is read here. The
// repository's own files are held to them by the second describe of this file's real-file half (tasks T035).

describe('parseTag', () => {
  it.each(['v0.1.0', 'v0.1.0-rc.1', 'v10.20.30', 'v1.0.0-alpha-1', 'v0.0.0', 'v1.2.3-rc.1.2'])('accepts %s', (tag) => {
    expect(parseTag(tag)).not.toBeNull();
  });

  it.each([
    ['v0.1', 'two numbers only'],
    ['0.1.0', 'no v'],
    ['V0.1.0', 'capital V'],
    ['v0.1.0+build', 'build metadata (Docker tags cannot hold +)'],
    ['v01.0.0', 'leading zero in the major'],
    ['v0.01.0', 'leading zero in the minor'],
    ['v0.1.00', 'leading zero in the patch'],
    ['v0.1.0-', 'empty suffix'],
    ['v0.1.0-rc..1', 'empty identifier'],
    ['v0.1.0-rc.1 ', 'trailing space'],
    [' v0.1.0', 'leading space'],
    ['v0.1.0\n', 'a trailing newline'],
    ['v0.1.0-rc.1\nv9.9.9', 'a second line'],
    ['', 'the empty string'],
    ['v0.1.0$(id)', 'a command substitution'],
    ['v0.1.0;ls', 'a shell separator'],
    ['v0.1.0-rc/1', 'a slash'],
  ])('refuses %j (%s)', (tag) => {
    expect(parseTag(tag)).toBeNull();
  });

  it('returns the core, the suffix and whether it is a pre-release', () => {
    expect(parseTag('v0.1.0')).toEqual({ version: '0.1.0', core: '0.1.0', suffix: '', prerelease: false });
    expect(parseTag('v0.1.0-rc.1')).toEqual({ version: '0.1.0-rc.1', core: '0.1.0', suffix: 'rc.1', prerelease: true });
    expect(parseTag('v10.20.30-alpha-1')).toEqual({
      version: '10.20.30-alpha-1',
      core: '10.20.30',
      suffix: 'alpha-1',
      prerelease: true,
    });
  });
});

describe('compareFinal', () => {
  it('orders versions by their numbers, not as text', () => {
    expect(compareFinal('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareFinal('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareFinal('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareFinal('0.1.2', '0.1.10')).toBeLessThan(0);
    expect(compareFinal('0.1.0', '0.1.0')).toBe(0);
  });
});

describe('findChangelogEntry', () => {
  const changelog = [
    '# Changelog',
    '',
    'About this file.',
    '',
    '## [0.2.0] - 2026-12-01',
    '### What you can do',
    'Newer things.',
    '',
    '## [0.1.0] - 2026-10-12',
    '',
    '### What you can do',
    'Draw.',
    '',
    '### Upgrading',
    'Back up first.',
    '',
    '[0.2.0]: https://example.invalid/0.2.0',
  ].join('\n');

  it('returns the text under the heading, up to the next entry', () => {
    expect(findChangelogEntry(changelog, '0.2.0')).toBe('### What you can do\nNewer things.');
  });

  it('returns the text up to the end of the file for the last entry, trimmed', () => {
    expect(findChangelogEntry(changelog, '0.1.0')).toBe(
      '### What you can do\nDraw.\n\n### Upgrading\nBack up first.\n\n[0.2.0]: https://example.invalid/0.2.0',
    );
  });

  it('returns nothing for a version with no entry', () => {
    expect(findChangelogEntry(changelog, '0.3.0')).toBeNull();
  });

  it('returns nothing for an entry that is not dated', () => {
    expect(findChangelogEntry('## [0.1.0] - Unreleased\nText', '0.1.0')).toBeNull();
    expect(findChangelogEntry('## [0.1.0]\nText', '0.1.0')).toBeNull();
  });

  it('returns nothing for a date that is not a date', () => {
    expect(findChangelogEntry('## [0.1.0] - 2026-13-45\nText', '0.1.0')).toBeNull();
    expect(findChangelogEntry('## [0.1.0] - 26-10-12\nText', '0.1.0')).toBeNull();
  });

  it('does not take 0.1.01 or 0.1.0-rc.1 for 0.1.0', () => {
    expect(findChangelogEntry('## [0.1.01] - 2026-10-12\nText', '0.1.0')).toBeNull();
    expect(findChangelogEntry('## [0.1.0-rc.1] - 2026-10-12\nText', '0.1.0')).toBeNull();
  });

  it('does not take a heading that is not at the start of a line', () => {
    expect(findChangelogEntry('text ## [0.1.0] - 2026-10-12\nMore', '0.1.0')).toBeNull();
  });
});

describe('composeDefaultVersion', () => {
  const compose = ['services:', '  app:', '    image: ghcr.io/shivamsaraswat/scrylux:${SCRYLUX_VERSION:-0.1.0}'].join('\n');

  it('reads the default of SCRYLUX_VERSION', () => {
    expect(composeDefaultVersion(compose)).toBe('0.1.0');
  });

  it('reads a pre-release default too', () => {
    expect(composeDefaultVersion('image: x:${SCRYLUX_VERSION:-0.1.0-rc.1}')).toBe('0.1.0-rc.1');
  });

  it('returns nothing for a file with no such default', () => {
    expect(composeDefaultVersion('services: {}')).toBeNull();
    expect(composeDefaultVersion('image: x:${OTHER:-0.1.0}')).toBeNull();
    expect(composeDefaultVersion('image: x:${SCRYLUX_VERSION}')).toBeNull();
  });
});

describe('packagesAgree', () => {
  const same = ['apps/api', 'apps/web', 'packages/core', 'packages/db', 'packages/threat-library'].map((path) => ({
    path: `${path}/package.json`,
    version: '0.1.0',
  }));

  it('is empty when every package carries one version', () => {
    expect(packagesAgree(same)).toEqual([]);
  });

  it('names the package that differs from the majority', () => {
    const odd = same.map((p) => (p.path.startsWith('packages/db') ? { ...p, version: '0.1.1' } : p));
    expect(packagesAgree(odd)).toEqual(['packages/db/package.json']);
  });

  it('names every package that differs', () => {
    const odd = same.map((p, i) => (i < 2 ? { ...p, version: '0.2.0' } : p));
    expect(packagesAgree(odd)).toEqual(['apps/api/package.json', 'apps/web/package.json']);
  });
});

describe('pinComposeVersion', () => {
  const compose = [
    'services:',
    '  app:',
    '    image: ghcr.io/shivamsaraswat/scrylux:${SCRYLUX_VERSION:-0.1.0}',
    '    ports: ["127.0.0.1:${PORT:-3000}:3000"]',
  ].join('\n');

  it('replaces the default for a pre-release and changes nothing else', () => {
    const pinned = pinComposeVersion(compose, '0.1.0-rc.1');
    expect(pinned).toBe(compose.replace('${SCRYLUX_VERSION:-0.1.0}', '${SCRYLUX_VERSION:-0.1.0-rc.1}'));
    expect(pinned).toContain('${PORT:-3000}');
  });

  it('returns the text unchanged for a final version', () => {
    expect(pinComposeVersion(compose, '0.1.0')).toBe(compose);
  });

  it('throws on a file with no default to replace', () => {
    expect(() => pinComposeVersion('services: {}', '0.1.0-rc.1')).toThrow(/SCRYLUX_VERSION/);
    expect(() => pinComposeVersion('services: {}', '0.1.0')).toThrow(/SCRYLUX_VERSION/);
  });
});

describe('labels', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';

  it('gives the six labels of the image contract', () => {
    const labels = expectedLabels({ version: '0.1.0', sha });
    expect(Object.keys(labels).sort()).toEqual([
      'org.opencontainers.image.description',
      'org.opencontainers.image.licenses',
      'org.opencontainers.image.revision',
      'org.opencontainers.image.source',
      'org.opencontainers.image.title',
      'org.opencontainers.image.version',
    ]);
    expect(labels['org.opencontainers.image.source']).toBe('https://github.com/shivamsaraswat/scrylux');
    expect(labels['org.opencontainers.image.version']).toBe('0.1.0');
    expect(labels['org.opencontainers.image.revision']).toBe(sha);
    expect(labels['org.opencontainers.image.licenses']).toBe('Apache-2.0');
    expect(labels['org.opencontainers.image.title']).toBe('Scrylux');
    expect(labels['org.opencontainers.image.description']?.trim()).toBeTruthy();
  });

  it('prints them as key=value lines, for the build step', () => {
    const lines = labelArgs({ version: '0.1.0-rc.1', sha });
    expect(lines).toHaveLength(6);
    expect(lines).toContain('org.opencontainers.image.version=0.1.0-rc.1');
    expect(lines).toContain(`org.opencontainers.image.revision=${sha}`);
    for (const line of lines) expect(line).toMatch(/^org\.opencontainers\.image\.[a-z]+=\S.*$/);
  });

  it('accepts labels that equal the expected ones, extra labels included', () => {
    const expected = expectedLabels({ version: '0.1.0', sha });
    expect(checkLabels({ ...expected, 'some.other': 'label' }, expected)).toEqual([]);
  });

  it('names each label that is missing or differs', () => {
    const expected = expectedLabels({ version: '0.1.0', sha });
    const actual: Record<string, string> = { ...expected, 'org.opencontainers.image.version': '0.1.1' };
    delete actual['org.opencontainers.image.revision'];
    const problems = checkLabels(actual, expected);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('org.opencontainers.image.version');
    expect(problems.join('\n')).toContain('0.1.1');
    expect(problems.join('\n')).toContain('org.opencontainers.image.revision');
    expect(problems.join('\n')).toMatch(/missing/);
  });
});

describe('formatFinding', () => {
  it('prints the two lines of the checks contract', () => {
    expect(formatFinding({ file: 'CHANGELOG.md', check: 'versions', message: 'no entry for 0.1.0', fix: 'add it' })).toBe(
      'CHANGELOG.md: versions — no entry for 0.1.0\n  fix: add it',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Check V on the files themselves (contracts/checks.md row V; spec FR-013, FR-015, FR-034, SC-004). `checkVersions` is a pure
// function of the files' text, so each condition is shown to fail on a copy with exactly that condition broken.

const ENTRY = [
  '## [0.1.0] - 2026-10-12',
  '',
  '### What you can do',
  'Draw.',
  '',
  '### What it does not do yet',
  'No roles.',
  '',
  '### Upgrading',
  'Back up first.',
].join('\n');

const PREAMBLE = 'What changed. Open risks are in [the threat model](docs/threat-model/); report a vulnerability as [SECURITY.md](SECURITY.md) says.';
const CHANGELOG = `# Changelog\n\n${PREAMBLE}\n\n${ENTRY}\n`;
const PACKAGES = ['apps/api', 'apps/web', 'packages/core', 'packages/db', 'packages/threat-library'].map((p) => ({ path: `${p}/package.json`, version: '0.1.0' }));

const input = (over: Partial<Parameters<typeof checkVersions>[0]> = {}) => ({ packages: PACKAGES, composeDefault: '0.1.0', changelog: CHANGELOG, ...over });
const said = (over: Partial<Parameters<typeof checkVersions>[0]> = {}) => checkVersions(input(over)).map(formatFinding).join('\n');

describe('checkVersions', () => {
  it('finds nothing when the packages, the compose default and the changelog agree', () => {
    expect(checkVersions(input())).toEqual([]);
  });

  it('names the packages that disagree, with their versions, and the fix', () => {
    const packages = PACKAGES.map((p) => (p.path.startsWith('packages/db') ? { ...p, version: '0.1.1' } : p));
    const text = said({ packages });
    expect(text).toContain('packages/db/package.json');
    expect(text).toContain('0.1.1');
    expect(text).toContain('0.1.0');
    expect(text).toMatch(/fix:/);
  });

  it('names the compose file when its default differs or is missing', () => {
    expect(said({ composeDefault: '0.2.0' })).toContain('docker-compose.release.yml');
    expect(said({ composeDefault: '0.2.0' })).toContain('0.2.0');
    expect(said({ composeDefault: null })).toMatch(/no SCRYLUX_VERSION default/);
  });

  it('names the heading expected when the changelog has no dated entry for the version', () => {
    expect(said({ changelog: CHANGELOG.replace('## [0.1.0] - 2026-10-12', '## [0.1.0] - Unreleased') })).toContain('## [0.1.0] - YYYY-MM-DD');
    expect(said({ changelog: PREAMBLE })).toContain('## [0.1.0] - YYYY-MM-DD');
  });

  it('refuses an entry that has none of the three headings, or one that invents another', () => {
    expect(said({ changelog: `${PREAMBLE}\n\n## [0.1.0] - 2026-10-12\n\nText only.\n` })).toMatch(/none of the headings/);
    expect(said({ changelog: CHANGELOG.replace('### Upgrading', '### Misc') })).toContain('### Misc');
  });

  it('accepts an entry that has only some of the headings, such as a patch release', () => {
    expect(checkVersions(input({ changelog: `${PREAMBLE}\n\n## [0.1.0] - 2026-10-12\n\n### Upgrading\nBack up first.\n` }))).toEqual([]);
  });

  it('wants the changelog to link the threat model and SECURITY.md (FR-034)', () => {
    expect(said({ changelog: CHANGELOG.replace('(docs/threat-model/)', '(elsewhere)') })).toContain('docs/threat-model/');
    expect(said({ changelog: CHANGELOG.replace('(SECURITY.md)', '(elsewhere)') })).toContain('SECURITY.md');
  });

  it('checks the version the packages carry, and not a version nobody uses', () => {
    const packages = PACKAGES.map((p) => ({ ...p, version: '0.2.0' }));
    const text = said({ packages });
    expect(text).toContain('## [0.2.0] - YYYY-MM-DD');
    expect(text).toContain('0.2.0');
  });

  it('never prints the changelog text', () => {
    const text = said({ changelog: `${PREAMBLE}\n\n## [0.1.0] - 2026-10-12\n\nSENSITIVE-BODY-TEXT\n` });
    expect(text).not.toContain('SENSITIVE-BODY-TEXT');
  });
});

describe("this repository's own files", () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');
  const packages = ['apps/api', 'apps/web', 'packages/core', 'packages/db', 'packages/threat-library'].map((p) => ({
    path: `${p}/package.json`,
    version: (JSON.parse(read(`${p}/package.json`)) as { version: string }).version,
  }));
  const files = { packages, composeDefault: composeDefaultVersion(read('docker-compose.release.yml')), changelog: read('CHANGELOG.md') };

  it('carry one version everywhere, with a dated, well-formed changelog entry for it (SC-004)', () => {
    const findings = checkVersions(files);
    if (findings.length > 0) throw new Error(`\n${findings.map(formatFinding).join('\n\n')}`);
  });

  it('give the first release all three headings, and the notes can be built from it', () => {
    const entry = findChangelogEntry(files.changelog, '0.1.0') ?? '';
    for (const heading of ['### What you can do', '### What it does not do yet', '### Upgrading']) expect(entry, heading).toContain(heading);
  });
});
