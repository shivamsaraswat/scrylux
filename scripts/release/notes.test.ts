import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildNotes } from './notes.js';

// The release page of contracts/release-artifacts.md ("The release page") for a fixed input. It is a pure function, so the
// output for one input is one string, and the tests hold that string (check N, spec FR-012, FR-034, FR-037).

const DIGEST = `sha256:${'ab'.repeat(32)}`;
const CHANGELOG = [
  '# Changelog',
  '',
  'This file records what changed.',
  '',
  '## [0.1.0] - 2026-10-12',
  '',
  '### What you can do',
  'Draw a diagram.',
  '',
  '### What it does not do yet',
  'No roles.',
  '',
  '### Upgrading',
  'Back up first.',
  '',
  '[0.1.0]: https://github.com/shivamsaraswat/specter/releases/tag/v0.1.0',
].join('\n');

const FINAL = [
  '### What you can do',
  'Draw a diagram.',
  '',
  '### What it does not do yet',
  'No roles.',
  '',
  '### Upgrading',
  'Back up first.',
  '',
  '[0.1.0]: https://github.com/shivamsaraswat/specter/releases/tag/v0.1.0',
  '',
  '## Run it',
  '',
  'Download the attached `docker-compose.yml`, then:',
  '',
  '```sh',
  'docker compose up -d',
  '```',
  '',
  '- Image: `ghcr.io/shivamsaraswat/specter:0.1.0`',
  `- Digest: \`${DIGEST}\``,
  `- Pin it: \`ghcr.io/shivamsaraswat/specter@${DIGEST}\``,
  '',
  'This image is **not signed** and carries no build attestation or SBOM in this release, so pin it by its digest. Verifiable release images are planned for Phase 6 (`plan.md`).',
  '',
  "Open risks are recorded in Specter's own threat model: [`docs/threat-model/`](https://github.com/shivamsaraswat/specter/tree/v0.1.0/docs/threat-model). To report a vulnerability, follow [`SECURITY.md`](https://github.com/shivamsaraswat/specter/blob/v0.1.0/SECURITY.md) and report it privately; never open a public issue.",
  '',
  '## Attached',
  '',
  '- `docker-compose.yml`: the file the quickstart downloads; it starts this version.',
  '- `notes-app.specter.json`: a fictional demo threat model; load it with **Import threat model**.',
  '',
].join('\n');

describe('buildNotes', () => {
  it('is the changelog entry followed by what to run, the image, the digest and the attachments', () => {
    expect(buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: DIGEST, prerelease: false })).toBe(FINAL);
  });

  it('leaves out the entry heading and nothing else of the entry', () => {
    const notes = buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: DIGEST, prerelease: false });
    expect(notes).not.toContain('## [0.1.0]');
    expect(notes).toContain('### Upgrading\nBack up first.');
  });

  it('says the image is not signed and gives the digest to pin (FR-037)', () => {
    const notes = buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: DIGEST, prerelease: false });
    expect(notes).toMatch(/not signed/);
    expect(notes).toMatch(/no build attestation or SBOM/);
    expect(notes).toContain(`ghcr.io/shivamsaraswat/specter@${DIGEST}`);
  });

  it('links the threat model and SECURITY.md and says not to open a public issue (FR-034)', () => {
    const notes = buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: DIGEST, prerelease: false });
    expect(notes).toContain('docs/threat-model');
    expect(notes).toContain('SECURITY.md');
    expect(notes).toMatch(/never open a public issue/);
  });

  it('names the two attachments by the names the pipeline uploads', () => {
    const notes = buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: DIGEST, prerelease: false });
    expect(notes).toContain('`docker-compose.yml`');
    expect(notes).toContain('`notes-app.specter.json`');
  });

  it('does not call the version secure (FR-034)', () => {
    const notes = buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: DIGEST, prerelease: false });
    expect(notes).not.toMatch(/\bsecure\b/i);
  });

  it('starts a release candidate with its own sentence, names its own tag and uses the core version entry', () => {
    const notes = buildNotes({ changelog: CHANGELOG, version: '0.1.0-rc.1', core: '0.1.0', digest: DIGEST, prerelease: true });
    expect(notes.startsWith('This is a release candidate.\n\n### What you can do')).toBe(true);
    expect(notes).toContain('- Image: `ghcr.io/shivamsaraswat/specter:0.1.0-rc.1`');
    expect(notes).toContain('/tree/v0.1.0-rc.1/docs/threat-model');
  });

  it('fails clearly when the changelog has no entry for the core version', () => {
    expect(() => buildNotes({ changelog: CHANGELOG, version: '0.2.0', core: '0.2.0', digest: DIGEST, prerelease: false })).toThrow(
      /CHANGELOG\.md has no dated entry for 0\.2\.0/,
    );
  });

  it('refuses a digest that is not a sha256 digest', () => {
    expect(() => buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: 'latest', prerelease: false })).toThrow(/digest/);
    expect(() => buildNotes({ changelog: CHANGELOG, version: '0.1.0', core: '0.1.0', digest: `sha256:${'a'.repeat(63)}`, prerelease: false })).toThrow(
      /digest/,
    );
  });
});

describe('the command line', () => {
  const run = (args: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'notes-'));
    const changelog = path.join(dir, 'CHANGELOG.md');
    const compose = path.join(dir, 'docker-compose.release.yml');
    writeFileSync(changelog, CHANGELOG);
    writeFileSync(compose, 'image: ghcr.io/shivamsaraswat/specter:${SPECTER_VERSION:-0.1.0}\n');
    const out = path.join(dir, 'out');
    const result = spawnSync('pnpm', ['--silent', 'exec', 'tsx', path.resolve(import.meta.dirname, 'notes.ts'), changelog, compose, ...args, out], {
      encoding: 'utf8',
      cwd: path.resolve(import.meta.dirname, '..', '..'),
    });
    return { out, result };
  };

  it('writes notes.md and a compose copy pinned for a pre-release', () => {
    const { out, result } = run(['0.1.0-rc.1', DIGEST, 'true']);
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(out, 'notes.md'), 'utf8')).toContain('This is a release candidate.');
    expect(readFileSync(path.join(out, 'docker-compose.yml'), 'utf8')).toContain('${SPECTER_VERSION:-0.1.0-rc.1}');
  });

  it('writes the compose file as committed for a final release', () => {
    const { out, result } = run(['0.1.0', DIGEST, 'false']);
    expect(result.status).toBe(0);
    expect(readFileSync(path.join(out, 'docker-compose.yml'), 'utf8')).toBe('image: ghcr.io/shivamsaraswat/specter:${SPECTER_VERSION:-0.1.0}\n');
  });

  it('refuses when the pre-release flag does not match the version', () => {
    const { result } = run(['0.1.0-rc.1', DIGEST, 'false']);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/pre-release/);
  });
});
