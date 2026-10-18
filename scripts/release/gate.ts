import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFinal, composeDefaultVersion, findChangelogEntry, labelArgs, parseTag } from './versions.js';

// The gate of the release pipeline (contracts/release-pipeline.md "The gate", "Resume"; spec FR-002, FR-005, FR-007).
// `decide` is a pure function of what the command-line wrapper below gathers on the runner, so each refusal is a unit test
// with no GitHub and no registry. It reports the FIRST condition that fails, in the order of the contract.

export interface RequiredCheck {
  context: string;
  appId: number;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  appId: number;
}

export type ImageState = { exists: false } | { exists: true; digest: string; revision: string | null };

export interface GateInput {
  // The tag as pushed (GITHUB_REF_NAME). It is text a pusher chose: nothing here runs it.
  tag: string;
  sha: string;
  onMain: boolean;
  defaultBranch: string;
  packages: { path: string; version: string }[];
  composeDefault: string | null;
  changelog: string;
  requiredChecks: RequiredCheck[];
  checkRuns: CheckRun[];
  image: ImageState;
  releaseExists: boolean;
  // Every `v*` tag of the repository, this one included.
  finalTags: string[];
}

export interface Refusal {
  gate: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
  condition: string;
  fix: string;
}

export interface GateOutputs {
  version: string;
  core: string;
  prerelease: boolean;
  is_latest: boolean;
  image_published: boolean;
  image_digest: string;
  release_published: boolean;
}

export type GateResult = GateOutputs | { refused: Refusal };

const refuse = (gate: Refusal['gate'], condition: string, fix: string): { refused: Refusal } => ({ refused: { gate, condition, fix } });

export function decide(input: GateInput): GateResult {
  const parsed = parseTag(input.tag);
  if (parsed === null) {
    return refuse(
      'G1',
      `the tag "${input.tag}" is not a version tag`,
      'a version tag is vMAJOR.MINOR.PATCH with an optional -suffix such as -rc.1 (no build metadata): delete this tag and push a correct one by name',
    );
  }

  if (!input.onMain) {
    return refuse(
      'G2',
      `the tagged commit ${input.sha} is not on ${input.defaultBranch}`,
      `tag a commit that is on ${input.defaultBranch} (merge the pull request first), delete the tag with \`git push origin --delete ${input.tag}\`, and push the right tag by name`,
    );
  }

  const differs: string[] = input.packages.filter((p) => p.version !== parsed.core).map((p) => `${p.path} is ${p.version}`);
  if (input.composeDefault === null) differs.push('docker-compose.release.yml has no SCRYLUX_VERSION default');
  else if (input.composeDefault !== parsed.core) differs.push(`docker-compose.release.yml defaults to ${input.composeDefault}`);
  if (differs.length > 0) {
    return refuse(
      'G3',
      `the versions do not agree with the tag's version ${parsed.core}: ${differs.join('; ')}`,
      `set every package.json and the default of SCRYLUX_VERSION in docker-compose.release.yml to ${parsed.core} in a pull request, merge it, and tag the merge commit (a release candidate carries the version it is a candidate for)`,
    );
  }

  if (findChangelogEntry(input.changelog, parsed.core) === null) {
    return refuse(
      'G4',
      `CHANGELOG.md has no dated entry headed "## [${parsed.core}] - YYYY-MM-DD"`,
      'add the entry in the pull request that prepares the release, merge it, and tag the merge commit',
    );
  }

  const notGreen: string[] = [];
  let running = false;
  for (const { context, appId } of input.requiredChecks) {
    const runs = input.checkRuns.filter((r) => r.name === context && r.appId === appId);
    if (runs.some((r) => r.status === 'completed' && r.conclusion === 'success')) continue;
    const live = runs.find((r) => r.status !== 'completed');
    if (live !== undefined) {
      running = true;
      notGreen.push(`${context} (still running)`);
    } else if (runs.length > 0) {
      notGreen.push(`${context} (${runs.map((r) => r.conclusion ?? 'no conclusion').join(', ')})`);
    } else {
      notGreen.push(`${context} (missing)`);
    }
  }
  if (notGreen.length > 0) {
    return refuse(
      'G5',
      `the required checks are not green on ${input.sha}: ${notGreen.join('; ')}`,
      running
        ? 'wait for the running checks to finish, then re-run this workflow (the run\'s page, Re-run all jobs); if one failed, fix it on main and tag the commit that passes'
        : 'fix the failing or missing checks on main and tag a commit whose required checks all passed',
    );
  }

  if (input.image.exists && input.image.revision !== input.sha) {
    return refuse(
      'G6',
      `the image for ${parsed.version} already exists (${input.image.digest}) and was built from ${input.image.revision ?? 'an unknown commit'}, not from ${input.sha}`,
      'a published version is never replaced: delete this tag and publish the next version (bump the versions and the changelog in a pull request)',
    );
  }

  const higher = input.finalTags.some((t) => {
    const other = parseTag(t);
    return other !== null && !other.prerelease && compareFinal(other.core, parsed.core) > 0;
  });

  return {
    version: parsed.version,
    core: parsed.core,
    prerelease: parsed.prerelease,
    is_latest: !parsed.prerelease && !higher,
    image_published: input.image.exists,
    image_digest: input.image.exists ? input.image.digest : '',
    release_published: input.releaseExists,
  };
}

// The one line of the contract, printed as an error annotation.
export function formatRefusal({ condition, fix }: Refusal): string {
  return `release refused: ${condition}. ${fix}`;
}

// A workflow command is `::error::<data>`. The runner decodes %25, %0D and %0A in the data, so text that names the tag (which
// the pusher chose) must have those three encoded, or a tag such as `v1%0A::…` becomes a second command.
export function escapeCommandData(data: string): string {
  return data.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

// ---------------------------------------------------------------------------------------------------------------------
// The command line: gathers the inputs on the runner. Not unit-tested (it needs git, GitHub and a registry); the rehearsal
// candidate exercises it (tasks.md T056). Every value reaches it through the environment, never through a script expression.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = 'ghcr.io/shivamsaraswat/scrylux';
const PACKAGE_FILES = ['apps/api', 'apps/web', 'packages/core', 'packages/db', 'packages/threat-library'].map((p) => `${p}/package.json`);

interface Ran {
  status: number;
  stdout: Buffer;
  stderr: string;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Ran {
  try {
    const stdout = execFileSync(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
    return { status: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0), stderr: e.stderr?.toString('utf8') ?? '' };
  }
}

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`the environment variable ${name} is not set`);
  return value;
}

const readIfThere = (relative: string): string | null => (existsSync(path.join(ROOT, relative)) ? readFileSync(path.join(ROOT, relative), 'utf8') : null);

function requiredChecks(): RequiredCheck[] {
  const ruleset = JSON.parse(readFileSync(path.join(ROOT, '.github/rulesets/main.json'), 'utf8')) as {
    rules: { type: string; parameters?: { required_status_checks?: { context: string; integration_id: number }[] } }[];
  };
  const rule = ruleset.rules.find((r) => r.type === 'required_status_checks');
  return (rule?.parameters?.required_status_checks ?? []).map((c) => ({ context: c.context, appId: c.integration_id }));
}

function checkRunsOf(repo: string, sha: string): CheckRun[] {
  const out = run('gh', ['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs[] | {name, status, conclusion, appId: .app.id}']);
  if (out.status !== 0) throw new Error(`could not list the check runs of ${sha}: ${out.stderr.trim()}`);
  return out.stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CheckRun);
}

// Whether the registry holds `<image>:<version>`, and from which commit.
//
// GHCR answers "denied" (HTTP 403) for a package that does not exist yet, and for one the caller may not read, so "not
// found" alone would refuse the very first release (checked against ghcr.io on 2026-10-12, research #17 V9). "Denied" is
// therefore read as "not published". That cannot publish over an existing version: overwriting a tag takes write access, write
// includes read, so a token that can overwrite can also see the image and gets "found"; a token that is denied the read is
// denied the push, which fails without changing anything. Any other failure (a network error, a malformed answer) is an
// error, never "not there".
// What a registry says when a version is not there. The publish step of release.yml holds the same list as shell (`grep -Eiq`), and a
// test (gate.test.ts) fails if the two differ. Whole numbers only, so that a port or an address that holds 404 or 403 is not one.
export const NOT_PUBLISHED = /manifest unknown|name unknown|not found|\b404\b|denied|unauthorized|requested access|\b403\b/i;
export const isNotPublished = (answer: string): boolean => NOT_PUBLISHED.test(answer);

function imageState(version: string, creds: string): ImageState {
  const ref = `docker://${IMAGE}:${version}`;
  const raw = run('skopeo', ['inspect', '--raw', '--creds', creds, ref]);
  if (raw.status !== 0) {
    if (isNotPublished(raw.stderr)) return { exists: false };
    throw new Error(`could not ask the registry about ${IMAGE}:${version}: ${raw.stderr.trim()}`);
  }
  const digest = `sha256:${createHash('sha256').update(raw.stdout).digest('hex')}`;
  const index = JSON.parse(raw.stdout.toString('utf8')) as { manifests?: { digest: string; platform?: { os: string; architecture: string } }[] };
  const amd64 = index.manifests?.find((m) => m.platform?.os === 'linux' && m.platform.architecture === 'amd64');
  if (amd64 === undefined) return { exists: true, digest, revision: null };
  const config = run('skopeo', ['inspect', '--config', '--creds', creds, `docker://${IMAGE}@${amd64.digest}`]);
  if (config.status !== 0) throw new Error(`could not read the config of ${IMAGE}@${amd64.digest}: ${config.stderr.trim()}`);
  const labels = (JSON.parse(config.stdout.toString('utf8')) as { config?: { Labels?: Record<string, string> } }).config?.Labels ?? {};
  return { exists: true, digest, revision: labels['org.opencontainers.image.revision'] ?? null };
}

function releaseExists(tag: string): boolean {
  const out = run('gh', ['release', 'view', tag, '--json', 'tagName']);
  if (out.status === 0) return true;
  if (/release not found|not found/i.test(out.stderr)) return false;
  throw new Error(`could not ask GitHub about the release of ${tag}: ${out.stderr.trim()}`);
}

function gather(): GateInput {
  const tag = need('GITHUB_REF_NAME');
  const sha = need('GITHUB_SHA');
  const defaultBranch = need('DEFAULT_BRANCH');
  const repo = need('GITHUB_REPOSITORY');
  const creds = `${need('GITHUB_ACTOR')}:${need('GITHUB_TOKEN')}`;
  const ancestor = run('git', ['merge-base', '--is-ancestor', sha, `origin/${defaultBranch}`]);
  if (ancestor.status > 1) throw new Error(`could not tell whether ${sha} is on ${defaultBranch}: ${ancestor.stderr.trim()}`);
  const parsed = parseTag(tag);
  return {
    tag,
    sha,
    onMain: ancestor.status === 0,
    defaultBranch,
    packages: PACKAGE_FILES.map((p) => ({ path: p, version: (JSON.parse(readFileSync(path.join(ROOT, p), 'utf8')) as { version: string }).version })),
    composeDefault: composeDefaultVersion(readIfThere('docker-compose.release.yml') ?? ''),
    changelog: readIfThere('CHANGELOG.md') ?? '',
    requiredChecks: requiredChecks(),
    checkRuns: checkRunsOf(repo, sha),
    // Nothing is asked of the registry or of GitHub about a tag that is already refused at G1.
    image: parsed === null ? { exists: false } : imageState(parsed.version, creds),
    releaseExists: parsed === null ? false : releaseExists(tag),
    finalTags: run('git', ['tag', '-l', 'v*']).stdout.toString('utf8').split('\n').filter((t) => t !== ''),
  };
}

function main(): number {
  let result: GateResult;
  try {
    result = decide(gather());
  } catch (error) {
    console.log(`::error::${escapeCommandData(`release gate could not run: ${error instanceof Error ? error.message : String(error)}`)}`);
    return 1;
  }
  if ('refused' in result) {
    console.log(`::error::${escapeCommandData(formatRefusal(result.refused))}`);
    return 1;
  }
  writeFileSync(path.join(ROOT, 'gate.json'), `${JSON.stringify(result, null, 2)}\n`);
  const lines = Object.entries(result).map(([key, value]) => `${key}=${String(value)}`);
  // The labels of the image, one `key=value` per line, for the build job (which installs nothing and so cannot ask
  // versions.ts itself). A multi-line output takes a delimiter no label can contain.
  const labels = labelArgs({ version: result.version, sha: need('GITHUB_SHA') });
  lines.push('labels<<RELEASE_LABELS_EOF', ...labels, 'RELEASE_LABELS_EOF');
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile === undefined || outputFile === '') console.log(lines.join('\n'));
  else appendFileSync(outputFile, `${lines.join('\n')}\n`);
  return 0;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
