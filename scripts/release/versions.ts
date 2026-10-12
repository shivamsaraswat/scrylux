import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The version rules of Release v0.1 (specs/phase-2/milestone-8-release-v0-1/, contracts/release-artifacts.md "The version" and
// data-model.md §1). Everything here is a pure function of the text it is given: the gate, the notes and the checks all
// read one definition of "a version", of "the changelog entry for it" and of "the labels of the image".

export interface Finding {
  file: string;
  check: string;
  message: string;
  fix: string;
}

// The two lines of the checks contract (contracts/checks.md), the same form Milestone 7's checks print.
export function formatFinding({ file, check, message, fix }: Finding): string {
  return `${file}: ${check} — ${message}\n  fix: ${fix}`;
}

export interface ParsedTag {
  // The tag without its `v`: the image tag and the release title.
  version: string;
  // MAJOR.MINOR.PATCH: what the packages, the changelog and the compose default carry.
  core: string;
  // The part after the first `-`, empty for a final version.
  suffix: string;
  prerelease: boolean;
}

const NUMBER = '(?:0|[1-9]\\d*)';
const CORE = `${NUMBER}\\.${NUMBER}\\.${NUMBER}`;
const SUFFIX = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
// No `m` flag and no `$` tricks: the whole string must match, so a tag with a newline in it is not a version tag. Build
// metadata (`+x`) is refused because a Docker tag cannot hold a `+`.
const TAG = new RegExp(`^v(${CORE})(?:-(${SUFFIX}))?$`);
const CORE_ONLY = new RegExp(`^${CORE}$`);

export function parseTag(tag: string): ParsedTag | null {
  const match = TAG.exec(tag);
  const core = match?.[1];
  if (core === undefined) return null;
  const suffix = match?.[2] ?? '';
  return { version: tag.slice(1), core, suffix, prerelease: suffix !== '' };
}

const numbers = (core: string): number[] => core.split('.').map(Number);

// Orders two FINAL versions (no suffix) by their numbers. It is only used to decide whether a release moves `latest`, which
// a pre-release never does, so a suffix is never compared.
export function compareFinal(a: string, b: string): number {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const validDate = (year: number, month: number, day: number): boolean => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

// The text of the changelog entry headed `## [core] - YYYY-MM-DD`, up to the next `## [` heading or the end of the file, with
// the blank lines around it trimmed. Nothing for a missing entry, an entry that is not dated, a date that is not a date, or a
// version that is only a prefix of another (0.1.0 is not 0.1.01 and is not 0.1.0-rc.1).
export function findChangelogEntry(changelog: string, core: string): string | null {
  if (!CORE_ONLY.test(core)) return null;
  const heading = new RegExp(`^## \\[${core.replaceAll('.', '\\.')}\\] - (\\d{4})-(\\d{2})-(\\d{2})$`);
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => {
    const m = heading.exec(line);
    return m !== null && validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  });
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((line) => line.startsWith('## ['));
  return (next === -1 ? rest : rest.slice(0, next)).join('\n').trim();
}

const COMPOSE_DEFAULT = /\$\{SPECTER_VERSION:-([^}\s]+)\}/;

// The default of SPECTER_VERSION in the release compose file, or nothing.
export function composeDefaultVersion(compose: string): string | null {
  return COMPOSE_DEFAULT.exec(compose)?.[1] ?? null;
}

// The paths of the packages whose version differs from the most common one. Empty when they all agree.
export function packagesAgree(packages: { path: string; version: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.version, (counts.get(p.version) ?? 0) + 1);
  let majority = '';
  let best = 0;
  for (const [version, count] of counts) {
    if (count > best) {
      majority = version;
      best = count;
    }
  }
  return packages.filter((p) => p.version !== majority).map((p) => p.path);
}

// The compose file as it is attached to a release. For a pre-release the default of SPECTER_VERSION becomes the full version
// (`0.1.0-rc.1`), because only that image exists; for a final release the file is returned as committed, whose default is
// already the version (check V). Nothing else in the text changes.
export function pinComposeVersion(compose: string, version: string): string {
  if (!COMPOSE_DEFAULT.test(compose)) {
    throw new Error('the release compose file has no ${SPECTER_VERSION:-…} default to pin');
  }
  if (!version.includes('-')) return compose;
  return compose.replace(new RegExp(COMPOSE_DEFAULT.source, 'g'), () => `\${SPECTER_VERSION:-${version}}`);
}

export const IMAGE_SOURCE = 'https://github.com/shivamsaraswat/specter';

// The six labels of contracts/release-artifacts.md "The image". One definition: the build step sets them from here, and the
// smoke run and the anonymous-pull check compare the image to it.
export function expectedLabels({ version, sha }: { version: string; sha: string }): Record<string, string> {
  return {
    'org.opencontainers.image.source': IMAGE_SOURCE,
    'org.opencontainers.image.version': version,
    'org.opencontainers.image.revision': sha,
    'org.opencontainers.image.licenses': 'Apache-2.0',
    'org.opencontainers.image.title': 'Specter',
    'org.opencontainers.image.description': 'Specter, an open-source, self-hosted threat modeling platform.',
  };
}

// `key=value`, one per label, for `docker buildx build --label`.
export function labelArgs(input: { version: string; sha: string }): string[] {
  return Object.entries(expectedLabels(input)).map(([key, value]) => `${key}=${value}`);
}

// What is wrong with the labels an image carries. Labels the contract does not name are ignored.
export function checkLabels(actual: Record<string, string>, expected: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    const found = actual[key];
    if (found === undefined) problems.push(`label ${key} is missing (expected "${value}")`);
    else if (found !== value) problems.push(`label ${key} is "${found}", expected "${value}"`);
  }
  return problems;
}

const ENTRY_HEADINGS = ['What you can do', 'What it does not do yet', 'Upgrading'];

export interface VersionFiles {
  packages: { path: string; version: string }[];
  composeDefault: string | null;
  changelog: string;
}

// Check V (contracts/checks.md; spec FR-013, FR-015, FR-034): the packages carry one version, the compose file starts it, and the
// changelog has a dated entry for it in the form the contract gives, whose preamble links the threat model and SECURITY.md. The
// version is the one most packages carry, so that one package out of step is named, not the other four. A message names a file
// and a version or a heading, never the changelog's text.
export function checkVersions({ packages, composeDefault, changelog }: VersionFiles): Finding[] {
  const findings: Finding[] = [];
  const add = (file: string, message: string, fix: string): void => {
    findings.push({ file, check: 'versions', message, fix });
  };

  const counts = new Map<string, number>();
  for (const p of packages) counts.set(p.version, (counts.get(p.version) ?? 0) + 1);
  const version = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const differing = packagesAgree(packages);
  if (differing.length > 0) {
    const named = packages.filter((p) => differing.includes(p.path)).map((p) => `${p.path} is ${p.version}`);
    add(differing.join(', '), `the packages do not carry one version: ${named.join('; ')}, and most carry ${version}`, 'set the version of every package.json to the same value');
  }

  if (composeDefault === null) {
    add('docker-compose.release.yml', 'it has no SPECTER_VERSION default', 'give the image tag the form ${SPECTER_VERSION:-<version>}');
  } else if (composeDefault !== version) {
    add('docker-compose.release.yml', `its SPECTER_VERSION default is ${composeDefault}, and the packages carry ${version}`, `set the default to ${version}`);
  }

  const entry = findChangelogEntry(changelog, version);
  if (entry === null) {
    add('CHANGELOG.md', `it has no dated entry headed "## [${version}] - YYYY-MM-DD"`, 'add the entry in the pull request that prepares the release');
  } else {
    const used = entry
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .map((line) => line.slice(4).trim());
    if (!used.some((heading) => ENTRY_HEADINGS.includes(heading))) {
      add('CHANGELOG.md', `the entry for ${version} has none of the headings "${ENTRY_HEADINGS.join('", "')}"`, 'group the entry under those headings');
    }
    for (const heading of used.filter((h) => !ENTRY_HEADINGS.includes(h))) {
      add('CHANGELOG.md', `the entry for ${version} has a heading that is not one of the three: ### ${heading}`, `use "${ENTRY_HEADINGS.join('", "')}"`);
    }
  }

  for (const [target, what] of [['(docs/threat-model/)', 'Specter\'s own threat model'], ['(SECURITY.md)', 'the security policy']] as const) {
    if (!changelog.includes(target)) add('CHANGELOG.md', `it does not link ${what}: ${target.slice(1, -1)}`, 'say in its introduction where open risks are recorded and how to report a vulnerability (FR-034)');
  }
  return findings;
}

function main(argv: string[]): number {
  const [command, version, sha] = argv;
  if (command !== 'labels' || version === undefined || sha === undefined) {
    console.error('usage: tsx scripts/release/versions.ts labels <version> <40-hex commit>');
    return 2;
  }
  if (parseTag(`v${version}`) === null) {
    console.error(`"${version}" is not a version (MAJOR.MINOR.PATCH with an optional -suffix)`);
    return 2;
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error('the commit must be 40 lowercase hex characters');
    return 2;
  }
  for (const line of labelArgs({ version, sha })) console.log(line);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
