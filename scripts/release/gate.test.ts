import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decide, escapeCommandData, formatRefusal, isNotPublished, NOT_PUBLISHED, type CheckRun, type GateInput, type GateResult } from './gate.js';

// The gate of contracts/release-pipeline.md ("The gate", "Resume"): a pure decision over what the command-line wrapper
// gathers, so every refusal is a unit test with no GitHub and no registry (check G, spec FR-002, FR-005, FR-007, SC-003).

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const DIGEST = `sha256:${'cd'.repeat(32)}`;
const ACTIONS = 15368;

const PACKAGES = ['apps/api', 'apps/web', 'packages/core', 'packages/db', 'packages/threat-library'].map((p) => ({
  path: `${p}/package.json`,
  version: '0.1.0',
}));

const CHANGELOG = '# Changelog\n\n## [0.1.0] - 2026-10-12\n\n### What you can do\nDraw.\n';
const REQUIRED = ['typecheck', 'lint', 'test', 'docker-build'].map((context) => ({ context, appId: ACTIONS }));
const RUNS_OK: CheckRun[] = REQUIRED.map(({ context }) => ({ name: context, status: 'completed', conclusion: 'success', appId: ACTIONS }));

// A good input: a final tag on a commit that is on main, all agreeing, with the checks green and nothing published.
function good(overrides: Partial<GateInput> = {}): GateInput {
  return {
    tag: 'v0.1.0',
    sha: SHA,
    onMain: true,
    defaultBranch: 'main',
    packages: PACKAGES,
    composeDefault: '0.1.0',
    changelog: CHANGELOG,
    requiredChecks: REQUIRED,
    checkRuns: RUNS_OK,
    image: { exists: false },
    releaseExists: false,
    finalTags: ['v0.1.0'],
    ...overrides,
  };
}

function refused(result: GateResult) {
  if (!('refused' in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.refused;
}

describe('a good tag', () => {
  it('passes and says what is to do', () => {
    expect(decide(good())).toEqual({
      version: '0.1.0',
      core: '0.1.0',
      prerelease: false,
      is_latest: true,
      image_published: false,
      image_digest: '',
      release_published: false,
    });
  });

  it('passes a release candidate whose packages, changelog and compose default carry the core version', () => {
    expect(decide(good({ tag: 'v0.1.0-rc.1', finalTags: [] }))).toEqual({
      version: '0.1.0-rc.1',
      core: '0.1.0',
      prerelease: true,
      is_latest: false,
      image_published: false,
      image_digest: '',
      release_published: false,
    });
  });
});

describe('G1: the tag shape', () => {
  it.each(['v0.1', '0.1.0', 'v0.1.0+x', 'v01.0.0', 'v1.0', 'release-1', 'v0.1.0-'])('refuses %s, naming the tag and the form', (tag) => {
    const r = refused(decide(good({ tag })));
    expect(r.gate).toBe('G1');
    expect(r.condition).toContain(tag);
    expect(r.fix).toMatch(/vMAJOR\.MINOR\.PATCH/);
  });
});

describe('G2: on main', () => {
  it('refuses a commit that is not an ancestor of the default branch, naming the commit and the branch', () => {
    const r = refused(decide(good({ onMain: false })));
    expect(r.gate).toBe('G2');
    expect(r.condition).toContain(SHA);
    expect(r.condition).toContain('main');
    expect(r.fix).toMatch(/delete the tag/i);
  });
});

describe('G3: versions agree', () => {
  it('refuses a package whose version differs from the tag, naming the file and both versions', () => {
    const packages = PACKAGES.map((p) => (p.path.startsWith('packages/db') ? { ...p, version: '0.1.1' } : p));
    const r = refused(decide(good({ packages })));
    expect(r.gate).toBe('G3');
    expect(r.condition).toContain('packages/db/package.json');
    expect(r.condition).toContain('0.1.1');
    expect(r.condition).toContain('0.1.0');
  });

  it('refuses every package that differs, not only the first', () => {
    const packages = PACKAGES.map((p, i) => (i < 2 ? { ...p, version: '0.2.0' } : p));
    const r = refused(decide(good({ packages })));
    expect(r.condition).toContain('apps/api/package.json');
    expect(r.condition).toContain('apps/web/package.json');
  });

  it('refuses a compose default that differs, and one that is missing', () => {
    const differs = refused(decide(good({ composeDefault: '0.2.0' })));
    expect(differs.gate).toBe('G3');
    expect(differs.condition).toContain('docker-compose.release.yml');
    expect(differs.condition).toContain('0.2.0');
    const missing = refused(decide(good({ composeDefault: null })));
    expect(missing.gate).toBe('G3');
    expect(missing.condition).toMatch(/no SCRYLUX_VERSION default/);
  });

  it('compares a candidate with its core version, not its suffix', () => {
    expect(refused(decide(good({ tag: 'v0.1.0-rc.1', packages: PACKAGES.map((p) => ({ ...p, version: '0.1.0-rc.1' })) }))).gate).toBe('G3');
    expect(refused(decide(good({ tag: 'v0.2.0-rc.1', finalTags: [] }))).gate).toBe('G3');
  });
});

describe('G4: the changelog entry', () => {
  it('refuses a changelog with no entry, naming the heading expected', () => {
    const r = refused(decide(good({ changelog: '# Changelog\n\n## [0.0.9] - 2026-01-01\n' })));
    expect(r.gate).toBe('G4');
    expect(r.condition).toContain('## [0.1.0] - YYYY-MM-DD');
  });

  it('refuses an entry that is not dated', () => {
    expect(refused(decide(good({ changelog: '## [0.1.0] - Unreleased\nText' }))).gate).toBe('G4');
  });

  it('looks for the core version for a candidate', () => {
    expect(decide(good({ tag: 'v0.1.0-rc.1', finalTags: [] }))).not.toHaveProperty('refused');
  });
});

describe('G5: the required checks', () => {
  it('refuses a check that is missing, naming it', () => {
    const checkRuns = RUNS_OK.filter((r) => r.name !== 'lint');
    const r = refused(decide(good({ checkRuns })));
    expect(r.gate).toBe('G5');
    expect(r.condition).toContain('lint');
    expect(r.condition).toMatch(/missing/);
  });

  it('refuses a check that failed, naming it and its conclusion', () => {
    const checkRuns = RUNS_OK.map((r) => (r.name === 'test' ? { ...r, conclusion: 'failure' } : r));
    const r = refused(decide(good({ checkRuns })));
    expect(r.gate).toBe('G5');
    expect(r.condition).toContain('test');
    expect(r.condition).toContain('failure');
  });

  it('refuses a check that is still running, and says to wait and re-run the workflow', () => {
    const checkRuns = RUNS_OK.map((r) => (r.name === 'docker-build' ? { ...r, status: 'in_progress', conclusion: null } : r));
    const r = refused(decide(good({ checkRuns })));
    expect(r.gate).toBe('G5');
    expect(r.condition).toContain('docker-build');
    expect(r.condition).toMatch(/still running/);
    expect(r.fix).toMatch(/wait/i);
    expect(r.fix).toMatch(/re-run/i);
  });

  it('names every check that is not green, not only the first', () => {
    const r = refused(decide(good({ checkRuns: [] })));
    for (const name of ['typecheck', 'lint', 'test', 'docker-build']) expect(r.condition).toContain(name);
  });

  it.each(['neutral', 'skipped', 'cancelled', 'timed_out', 'action_required'])('does not count a conclusion of %s', (conclusion) => {
    const checkRuns = RUNS_OK.map((r) => (r.name === 'typecheck' ? { ...r, conclusion } : r));
    expect(refused(decide(good({ checkRuns }))).gate).toBe('G5');
  });

  it('does not count a check run of the right name from another app', () => {
    const checkRuns = RUNS_OK.map((r) => (r.name === 'lint' ? { ...r, appId: 156372 } : r));
    expect(refused(decide(good({ checkRuns }))).gate).toBe('G5');
  });

  it('counts a green run even when an older run of the same name failed', () => {
    const checkRuns = [{ name: 'lint', status: 'completed', conclusion: 'failure', appId: ACTIONS }, ...RUNS_OK];
    expect(decide(good({ checkRuns }))).not.toHaveProperty('refused');
  });

  it('ignores checks that are not required', () => {
    const checkRuns = [...RUNS_OK, { name: 'analyze (actions)', status: 'completed', conclusion: 'failure', appId: ACTIONS }];
    expect(decide(good({ checkRuns }))).not.toHaveProperty('refused');
  });
});

describe('G6: the version is not another image', () => {
  it('refuses an image built from another commit, naming the digest and that commit', () => {
    const r = refused(decide(good({ image: { exists: true, digest: DIGEST, revision: OTHER_SHA } })));
    expect(r.gate).toBe('G6');
    expect(r.condition).toContain(DIGEST);
    expect(r.condition).toContain(OTHER_SHA);
    expect(r.fix).toMatch(/next version/i);
  });

  it('refuses an image with no revision label as another image', () => {
    expect(refused(decide(good({ image: { exists: true, digest: DIGEST, revision: null } }))).gate).toBe('G6');
  });
});

describe('the first failing gate is the one reported', () => {
  it('G1 before G2', () => expect(refused(decide(good({ tag: 'v0.1', onMain: false }))).gate).toBe('G1'));
  it('G2 before G3', () => expect(refused(decide(good({ onMain: false, composeDefault: '9.9.9' }))).gate).toBe('G2'));
  it('G3 before G4', () => expect(refused(decide(good({ composeDefault: '9.9.9', changelog: '' }))).gate).toBe('G3'));
  it('G4 before G5', () => expect(refused(decide(good({ changelog: '', checkRuns: [] }))).gate).toBe('G4'));
  it('G5 before G6', () => expect(refused(decide(good({ checkRuns: [], image: { exists: true, digest: DIGEST, revision: OTHER_SHA } }))).gate).toBe('G5'));
});

describe('is_latest', () => {
  it('is true for a final version that no other final tag is above', () => {
    expect(decide(good({ finalTags: ['v0.1.0', 'v0.0.9'] }))).toMatchObject({ is_latest: true });
  });

  it('is false for a final version below another final tag (a patch for an older line)', () => {
    expect(decide(good({ tag: 'v0.1.0', finalTags: ['v0.2.0', 'v0.1.0'] }))).toMatchObject({ is_latest: false });
  });

  it('compares numbers, not text', () => {
    expect(decide(good({ finalTags: ['v0.1.0', 'v0.0.10'] }))).toMatchObject({ is_latest: true });
  });

  it('is never true for a pre-release, even when no final tag exists', () => {
    expect(decide(good({ tag: 'v0.1.0-rc.1', finalTags: [] }))).toMatchObject({ is_latest: false });
  });

  it('ignores final tags that are not version tags', () => {
    expect(decide(good({ finalTags: ['v0.1.0', 'v9.9', 'release'] }))).toMatchObject({ is_latest: true });
  });
});

describe('resume (FR-007)', () => {
  it('an image published from this commit is reported with its digest, and the release is still to do', () => {
    expect(decide(good({ image: { exists: true, digest: DIGEST, revision: SHA } }))).toMatchObject({
      image_published: true,
      image_digest: DIGEST,
      release_published: false,
    });
  });

  it('an image and a release already published are both reported', () => {
    expect(decide(good({ image: { exists: true, digest: DIGEST, revision: SHA }, releaseExists: true }))).toMatchObject({
      image_published: true,
      image_digest: DIGEST,
      release_published: true,
    });
  });

  it('a release with no image is reported as it is (the pipeline publishes the image)', () => {
    expect(decide(good({ releaseExists: true }))).toMatchObject({ image_published: false, release_published: true });
  });
});

describe('formatRefusal', () => {
  it('is the one line of the contract', () => {
    const r = refused(decide(good({ onMain: false })));
    expect(formatRefusal(r)).toBe(`release refused: ${r.condition}. ${r.fix}`);
    expect(formatRefusal(r)).not.toContain('\n');
  });
});

describe('escapeCommandData', () => {
  // A refusal is printed as `::error::<message>`. The runner decodes %25, %0D and %0A in it, so a tag named `v1%0A::…` would
  // otherwise become a second workflow command. The message names the tag, which the pusher chose.
  it('encodes the three characters the runner decodes', () => {
    expect(escapeCommandData('a%b\r\nc')).toBe('a%25b%0D%0Ac');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeCommandData('release refused: the tag "v0.1" is not a version tag. Fix it.')).toBe('release refused: the tag "v0.1" is not a version tag. Fix it.');
  });

  it('makes a hostile tag one harmless line', () => {
    const hostile = 'v1%0A::set-output name=x::y';
    const r = refused(decide(good({ tag: hostile })));
    const line = `::error::${escapeCommandData(formatRefusal(r))}`;
    expect(line).not.toContain('\n');
    expect(line.split('\n')).toHaveLength(1);
    expect(line.startsWith('::error::release refused: ')).toBe(true);
    expect(line).toContain('%250A');
  });
});

// What the registry says when a version is not there (tasks.md T064; spec FR-007). The list is written twice, because the gate is
// code and the publish step is shell: the test ties the two so that they cannot drift, and holds what each must read as "not
// published" and as an error. Reading an outage as "not published" is the one mistake that matters: the gate would go on to build.
describe('isNotPublished', () => {
  it.each([
    'Error: reading manifest 0.1.0 in ghcr.io/shivamsaraswat/scrylux: manifest unknown',
    'Error: name unknown: repository name not known to registry',
    'Error: initializing source docker://ghcr.io/shivamsaraswat/scrylux:0.1.0: reading manifest: denied',
    'unauthorized: authentication required',
    'requested access to the resource is denied',
    'received unexpected HTTP status: 404 Not Found',
    'Get "https://ghcr.io/v2/shivamsaraswat/scrylux/manifests/0.1.0": 403 Forbidden',
    'the manifest was NOT FOUND',
  ])('reads %j as not published', (answer) => {
    expect(isNotPublished(answer)).toBe(true);
  });

  it.each([
    'dial tcp: lookup ghcr.io: no such host',
    'Get "https://ghcr.io/v2/": context deadline exceeded',
    'dial tcp 140.82.112.34:443: i/o timeout',
    'dial tcp 10.0.0.1:4043: connection refused',
    'net/http: TLS handshake timeout',
    'received unexpected HTTP status: 500 Internal Server Error',
    'received unexpected HTTP status: 503 Service Unavailable',
    'invalid character \'<\' looking for beginning of value',
    '',
  ])('reads %j as an error, not as "not published"', (answer) => {
    expect(isNotPublished(answer)).toBe(false);
  });
});

describe('the publish step reads the registry the same way as the gate', () => {
  const workflow = readFileSync(path.resolve(import.meta.dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const quoted = /grep -Eiq '([^']+)' <<< "\$answer"/.exec(workflow)?.[1];

  it('has the pattern at all, in the one place the publish step asks', () => {
    expect(quoted, 'no `grep -Eiq \'…\' <<< "$answer"` in release.yml').toBeDefined();
  });

  it('is the same pattern, so that the two cannot drift', () => {
    expect(quoted).toBe(NOT_PUBLISHED.source);
    expect(NOT_PUBLISHED.flags).toBe('i');
  });
});
