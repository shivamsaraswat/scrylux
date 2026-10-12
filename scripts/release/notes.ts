import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChangelogEntry, IMAGE_SOURCE, parseTag, pinComposeVersion } from './versions.js';

// The release page and the compose file a release attaches (contracts/release-artifacts.md "The release page"; spec FR-012,
// FR-034, FR-037). `buildNotes` is a pure function of its arguments. The command line is what the pipeline's read-only `notes`
// job runs: it needs the workspace's dependencies to run, which is why no job that holds a write permission does.

const IMAGE = 'ghcr.io/shivamsaraswat/specter';
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface NotesInput {
  changelog: string;
  // The full version of the tag, without its `v`: 0.1.0 or 0.1.0-rc.1.
  version: string;
  // The version of the packages and of the changelog entry: 0.1.0.
  core: string;
  digest: string;
  prerelease: boolean;
}

export function buildNotes({ changelog, version, core, digest, prerelease }: NotesInput): string {
  if (!DIGEST.test(digest)) throw new Error(`the image digest must be sha256: and 64 hex characters, not "${digest}"`);
  const entry = findChangelogEntry(changelog, core);
  if (entry === null) throw new Error(`CHANGELOG.md has no dated entry for ${core}; expected a heading "## [${core}] - YYYY-MM-DD"`);
  const tag = `v${version}`;
  const lines = [
    ...(prerelease ? ['This is a release candidate.', ''] : []),
    entry,
    '',
    '## Run it',
    '',
    'Download the attached `docker-compose.yml`, then:',
    '',
    '```sh',
    'docker compose up -d',
    '```',
    '',
    `- Image: \`${IMAGE}:${version}\``,
    `- Digest: \`${digest}\``,
    `- Pin it: \`${IMAGE}@${digest}\``,
    '',
    'This image is **not signed** and carries no build attestation or SBOM in this release, so pin it by its digest. Verifiable release images are planned for Phase 6 (`plan.md`).',
    '',
    `Open risks are recorded in Specter's own threat model: [\`docs/threat-model/\`](${IMAGE_SOURCE}/tree/${tag}/docs/threat-model). To report a vulnerability, follow [\`SECURITY.md\`](${IMAGE_SOURCE}/blob/${tag}/SECURITY.md) and report it privately; never open a public issue.`,
    '',
    '## Attached',
    '',
    '- `docker-compose.yml`: the file the quickstart downloads; it starts this version.',
    '- `notes-app.specter.json`: a fictional demo threat model; load it with **Import threat model**.',
    '',
  ];
  return lines.join('\n');
}

function main(argv: string[]): number {
  const [changelogPath, composePath, version, digest, prereleaseFlag, outDir] = argv;
  if ([changelogPath, composePath, version, digest, prereleaseFlag, outDir].some((a) => a === undefined)) {
    console.error('usage: tsx scripts/release/notes.ts <changelog-path> <compose-path> <version> <digest> <true|false> <out-dir>');
    return 2;
  }
  const parsed = parseTag(`v${version}`);
  if (parsed === null) {
    console.error(`"${version}" is not a version`);
    return 2;
  }
  if (String(parsed.prerelease) !== prereleaseFlag) {
    console.error(`the version ${version} ${parsed.prerelease ? 'is' : 'is not'} a pre-release, but the flag says ${String(prereleaseFlag)}`);
    return 2;
  }
  try {
    const notes = buildNotes({
      changelog: readFileSync(path.resolve(changelogPath as string), 'utf8'),
      version: parsed.version,
      core: parsed.core,
      digest: digest as string,
      prerelease: parsed.prerelease,
    });
    const compose = pinComposeVersion(readFileSync(path.resolve(composePath as string), 'utf8'), parsed.version);
    mkdirSync(path.resolve(outDir as string), { recursive: true });
    writeFileSync(path.join(path.resolve(outDir as string), 'notes.md'), notes);
    writeFileSync(path.join(path.resolve(outDir as string), 'docker-compose.yml'), compose);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
