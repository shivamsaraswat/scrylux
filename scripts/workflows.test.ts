import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The workflow policy of contracts/checks.md, row W (spec FR-006, FR-003, SC-009): what the release workflow may start
// from, which job may hold a write permission, and what no workflow may reference. It reads the files as structure, because
// "which job does this permission belong to" is not a question a regular expression can answer.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const ACTIONS = path.join(ROOT, '.github', 'actions');

type Doc = Record<string, unknown>;
type Step = { uses?: string; run?: string; name?: string };
interface Job {
  permissions?: Record<string, string> | string;
  steps?: Step[];
  uses?: string;
  needs?: string | string[];
  if?: string | boolean;
}
interface Loaded {
  file: string;
  text: string;
  doc: Doc;
}

function load(file: string): Loaded {
  const text = readFileSync(file, 'utf8');
  return { file: path.relative(ROOT, file), text, doc: parse(text) as Doc };
}

const workflows = (): Loaded[] =>
  readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml'))
    .sort()
    .map((f) => load(path.join(WORKFLOWS, f)));

const localActions = (): Loaded[] =>
  readdirSync(ACTIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(ACTIONS, d.name, 'action.yml'))
    .filter((f) => existsSync(f))
    .map(load);

const jobsOf = (w: Loaded): Record<string, Job> => (w.doc.jobs ?? {}) as Record<string, Job>;

function release(): Loaded {
  const file = path.join(WORKFLOWS, 'release.yml');
  if (!existsSync(file)) throw new Error('.github/workflows/release.yml does not exist yet (tasks.md T018)');
  return load(file);
}

// The steps of a workflow job or of a composite action.
const stepsOf = (job: Job): Step[] => job.steps ?? [];

// `permissions` of a job as a map; `write-all` is a write permission of everything.
function writes(permissions: Job['permissions']): string[] {
  if (permissions === undefined) return [];
  if (typeof permissions === 'string') return permissions === 'write-all' ? ['write-all'] : [];
  return Object.entries(permissions)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => scope);
}

describe('release.yml: how it starts (FR-001)', () => {
  it('is started by the push of a v* tag and by nothing else', () => {
    const on = release().doc.on as Record<string, unknown>;
    expect(Object.keys(on)).toEqual(['push']);
    expect(on.push).toEqual({ tags: ['v*'] });
  });

  it('has no branch, pull request, manual or scheduled trigger anywhere in its text', () => {
    const { text } = release();
    for (const trigger of ['pull_request', 'pull_request_target', 'workflow_dispatch', 'workflow_call', 'schedule', 'branches:']) {
      expect(text, trigger).not.toMatch(new RegExp(`^\\s*${trigger}`, 'm'));
    }
  });

  it('serialises the runs of one tag and never cancels one', () => {
    const concurrency = release().doc.concurrency as { group?: string; 'cancel-in-progress'?: unknown } | undefined;
    expect(concurrency?.group).toBeTruthy();
    expect(concurrency?.['cancel-in-progress']).toBe(false);
  });
});

describe('release.yml: the jobs and their permissions (FR-006)', () => {
  it('has the seven jobs of the contract, and no others', () => {
    expect(Object.keys(jobsOf(release())).sort()).toEqual(['build', 'gate', 'notes', 'publish-image', 'release', 'smoke', 'verify-public']);
  });

  it('holds no permission by default', () => {
    expect(release().doc.permissions).toEqual({});
  });

  it('holds a write permission only in publish-image (packages) and in release (contents), and exactly those', () => {
    const jobs = jobsOf(release());
    for (const [name, job] of Object.entries(jobs)) {
      const w = writes(job.permissions);
      if (name === 'publish-image') expect(w, name).toEqual(['packages']);
      else if (name === 'release') expect(w, name).toEqual(['contents']);
      else expect(w, `${name} must hold no write permission`).toEqual([]);
    }
    expect(jobs['publish-image']?.permissions).toEqual({ packages: 'write', contents: 'read' });
    expect(jobs.release?.permissions).toEqual({ contents: 'write' });
  });

  it('gives the gate exactly the three read scopes it needs', () => {
    expect(jobsOf(release()).gate?.permissions).toEqual({ contents: 'read', checks: 'read', packages: 'read' });
  });

  it('gives the other read-only jobs a contents read and nothing else', () => {
    const jobs = jobsOf(release());
    for (const name of ['build', 'smoke', 'verify-public', 'notes']) expect(jobs[name]?.permissions, name).toEqual({ contents: 'read' });
  });

  it('runs no repository code and installs nothing in a job that holds a write permission', () => {
    for (const [name, job] of Object.entries(jobsOf(release()))) {
      if (writes(job.permissions).length === 0) continue;
      for (const step of stepsOf(job)) {
        expect(step.uses ?? '', `${name}: ${step.name ?? step.uses ?? ''}`).not.toMatch(/setup-workspace/);
        expect(step.run ?? '', `${name}: ${step.name ?? ''}`).not.toMatch(/(^|[\s;&|(])(pnpm|npm|npx|tsx|node)(\s|$)/m);
      }
    }
  });
});

describe('release.yml: what the gate hands on (Constitution III)', () => {
  it('declares only outputs that some job reads, so none is left over', () => {
    const { text, doc } = release();
    const declared = Object.keys(((doc.jobs as Record<string, { outputs?: Record<string, string> }>).gate?.outputs ?? {}));
    expect(declared.length).toBeGreaterThan(0);
    for (const output of declared) {
      expect(text.includes(`needs.gate.outputs.${output}`), `the gate declares the output ${output} and no job reads it`).toBe(true);
    }
  });

  it('declares every output that a job reads', () => {
    const { text, doc } = release();
    const declared = new Set(Object.keys(((doc.jobs as Record<string, { outputs?: Record<string, string> }>).gate?.outputs ?? {})));
    for (const match of text.matchAll(/needs\.gate\.outputs\.(\w+)/g)) {
      expect(declared.has(match[1] ?? ''), `a job reads needs.gate.outputs.${match[1] ?? ''}, which the gate does not declare`).toBe(true);
    }
  });
});

describe('release.yml: the build (FR-003, FR-009)', () => {
  const runText = (job: Job | undefined): string => stepsOf(job ?? {}).map((s) => s.run ?? '').join('\n');

  it('builds the checkout and nothing from elsewhere: no cache, no artifact downloaded', () => {
    const steps = stepsOf(jobsOf(release()).build ?? {});
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.uses ?? '').not.toMatch(/actions\/cache/);
      expect(step.uses ?? '').not.toMatch(/actions\/download-artifact/);
    }
  });

  it('turns BuildKit’s default attestations off, because v0.1 ships none', () => {
    const text = runText(jobsOf(release()).build);
    expect(text).toContain('--provenance=false');
    expect(text).toContain('--sbom=false');
  });
});

describe('release.yml: nothing the pusher chooses becomes code (FR-006)', () => {
  it('writes no expression into a script other than a job output or a matrix value', () => {
    for (const [name, job] of Object.entries(jobsOf(release()))) {
      for (const step of stepsOf(job)) {
        for (const match of (step.run ?? '').matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)) {
          const expression = match[1] ?? '';
          expect(expression, `${name}: a run block holds \${{ ${expression} }}; pass it through env: instead`).toMatch(/^(needs\.[A-Za-z0-9_-]+\.outputs\.[A-Za-z0-9_-]+|matrix\.[A-Za-z0-9_-]+)$/);
        }
      }
    }
  });
});

describe('every workflow and local action', () => {
  const all = (): Loaded[] => [...workflows(), ...localActions()];

  it('pins every action that is not in this repository to a 40-character commit', () => {
    for (const { file, doc } of all()) {
      const jobs = (doc.jobs ?? {}) as Record<string, Job>;
      const composite = ((doc.runs ?? {}) as { steps?: Step[] }).steps ?? [];
      const uses = [
        ...composite.map((s) => s.uses),
        ...Object.values(jobs).flatMap((j) => [j.uses, ...stepsOf(j).map((s) => s.uses)]),
      ].filter((u): u is string => u !== undefined);
      for (const u of uses) {
        if (u.startsWith('./')) continue;
        expect(u, `${file}: "${u}" is not pinned to a full commit`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('references no secret other than the per-run GITHUB_TOKEN', () => {
    for (const { file, text } of all()) {
      for (const match of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
        expect(match[1], `${file} references secrets.${match[1] ?? ''}`).toBe('GITHUB_TOKEN');
      }
      expect(text, `${file} inherits secrets`).not.toMatch(/secrets:\s*inherit/);
    }
  });

  it('holds no write permission, except CodeQL’s one job and the release workflow’s two', () => {
    for (const w of workflows()) {
      if (w.file.endsWith('release.yml')) continue;
      expect(writes(w.doc.permissions as Job['permissions']), `${w.file} (top level)`).toEqual([]);
      for (const [name, job] of Object.entries(jobsOf(w))) {
        const found = writes(job.permissions);
        if (w.file.endsWith('codeql.yml') && name === 'analyze') expect(found, `${w.file}: ${name}`).toEqual(['security-events']);
        else expect(found, `${w.file}: ${name}`).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// When each job of release.yml runs (spec FR-007, FR-010, SC-003; tasks.md T063). The `if:` of a job decides what a failure
// upstream does: a job that accepts a *skipped* predecessor also runs when that predecessor was skipped because something before
// it failed. That is exactly the defect found by the review of this file (F-4): `verify-public` ran on an empty digest after a
// failed smoke run and blamed a private package. The conditions are evaluated, not matched as text, against the runs that matter.

type Result = 'success' | 'failure' | 'skipped';
interface Context {
  results: Record<string, Result>;
  outputs: Record<string, string>;
}

// The small part of GitHub's expression language that the conditions of this workflow use: `always()`, `needs.<job>.result`,
// `needs.<job>.outputs.<name>`, string literals, `==`, `!=`, `&&`, `||` and parentheses. Strings compare without case, as in GitHub.
function evaluate(condition: string, context: Context): boolean {
  const source = condition.replace(/^\s*\$\{\{/, '').replace(/\}\}\s*$/, '');
  const tokens = source.match(/'[^']*'|&&|\|\||==|!=|\(|\)|[A-Za-z_][\w.()-]*/g) ?? [];
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (): string => {
    const token = tokens[at];
    if (token === undefined) throw new Error(`the condition ends too soon: ${condition}`);
    at += 1;
    return token;
  };
  const value = (token: string): string | boolean => {
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === 'always()') return true;
    const m = /^needs\.([\w-]+)\.(result|outputs\.(\w+))$/.exec(token);
    if (!m) throw new Error(`the test does not know the expression "${token}" in: ${condition}`);
    const job = m[1] ?? '';
    return m[2] === 'result' ? (context.results[job] ?? 'skipped') : (context.outputs[`${job}.${m[3] ?? ''}`] ?? '');
  };
  const primary = (): string | boolean => {
    const token = take();
    if (token === '(') {
      const inner = or();
      if (take() !== ')') throw new Error(`a parenthesis is not closed in: ${condition}`);
      return inner;
    }
    return value(token);
  };
  const comparison = (): string | boolean => {
    const left = primary();
    const operator = peek();
    if (operator !== '==' && operator !== '!=') return left;
    take();
    const equal = String(left).toLowerCase() === String(primary()).toLowerCase();
    return operator === '==' ? equal : !equal;
  };
  const and = (): string | boolean => {
    let left = comparison();
    while (peek() === '&&') {
      take();
      const right = comparison();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  };
  const or = (): string | boolean => {
    let left = and();
    while (peek() === '||') {
      take();
      const right = and();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  };
  const answer = or();
  if (at !== tokens.length) throw new Error(`the test could not read all of: ${condition}`);
  return Boolean(answer);
}

const ORDER = ['gate', 'build', 'smoke', 'publish-image', 'verify-public', 'notes', 'release'];

// Plays a run of the workflow. A job that runs finishes with the outcome the scenario gives it (success unless named), and one
// that does not run is skipped. Without a status function in its `if:`, a job also needs every job it depends on to have succeeded.
function play(outcomes: Partial<Record<string, Result>>, outputs: Record<string, string>): Record<string, Result> {
  const jobs = jobsOf(release());
  const results: Record<string, Result> = {};
  for (const name of ORDER) {
    const job = jobs[name];
    if (job === undefined) throw new Error(`release.yml has no job ${name}`);
    const needs = job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
    const condition = job.if === undefined ? "success()" : String(job.if);
    const explicit = /always\(\)/.test(condition);
    const dependenciesPassed = needs.every((n) => results[n] === 'success');
    const runs = explicit || condition === 'success()' ? (explicit ? evaluate(condition, { results, outputs }) : dependenciesPassed) : dependenciesPassed && evaluate(condition, { results, outputs });
    results[name] = runs ? (outcomes[name] ?? 'success') : 'skipped';
  }
  return results;
}

describe('release.yml: when each job runs (FR-007, FR-010)', () => {
  const fresh = { 'gate.image_published': 'false' };
  const published = { 'gate.image_published': 'true' };

  it('runs every job for a fresh release', () => {
    expect(play({}, fresh)).toEqual({ gate: 'success', build: 'success', smoke: 'success', 'publish-image': 'success', 'verify-public': 'success', notes: 'success', release: 'success' });
  });

  it('on a re-run of a published version builds and publishes nothing, and still checks the pull and completes the release', () => {
    expect(play({}, published)).toEqual({ gate: 'success', build: 'skipped', smoke: 'skipped', 'publish-image': 'skipped', 'verify-public': 'success', notes: 'success', release: 'success' });
  });

  it('stops at a failed smoke run: nothing is published, nothing is verified, no release (the defect F-4)', () => {
    const run = play({ smoke: 'failure' }, fresh);
    expect(run.smoke).toBe('failure');
    expect(run['publish-image']).toBe('skipped');
    expect(run['verify-public'], 'verify-public must not run on a digest that was never published').toBe('skipped');
    expect(run.notes).toBe('skipped');
    expect(run.release).toBe('skipped');
  });

  it('stops at a failed build', () => {
    const run = play({ build: 'failure' }, fresh);
    expect(['smoke', 'publish-image', 'verify-public', 'notes', 'release'].map((j) => run[j])).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  });

  it('stops at a failed publish: nothing is verified and no release is made', () => {
    const run = play({ 'publish-image': 'failure' }, fresh);
    expect(run['verify-public']).toBe('skipped');
    expect(run.notes).toBe('skipped');
    expect(run.release).toBe('skipped');
  });

  it('makes no release when the anonymous pull fails, which is where a private package shows', () => {
    const run = play({ 'verify-public': 'failure' }, fresh);
    expect(run['publish-image']).toBe('success');
    expect(run.notes).toBe('skipped');
    expect(run.release).toBe('skipped');
  });

  it('runs nothing at all after a refusal by the gate', () => {
    const run = play({ gate: 'failure' }, fresh);
    expect(ORDER.slice(1).map((j) => run[j])).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
  });

  it('does not run the release before its notes exist, even when everything else did', () => {
    expect(play({ notes: 'failure' }, fresh).release).toBe('skipped');
  });
});

describe('the evaluator these tests use', () => {
  const context = { results: { gate: 'success', publish: 'skipped' } as Record<string, Result>, outputs: { 'gate.flag': 'true' } };
  it.each([
    ["always()", true],
    ["needs.gate.result == 'success'", true],
    ["needs.gate.result == 'SUCCESS'", true],
    ["needs.publish.result == 'success'", false],
    ["needs.gate.outputs.flag != 'true'", false],
    ["always() && (needs.gate.result == 'success' || needs.publish.result == 'success')", true],
    ["needs.publish.result == 'success' || needs.gate.outputs.flag == 'true'", true],
    ["needs.unknown.result == 'skipped'", true],
    ["${{ needs.gate.result == 'failure' }}", false],
  ])('reads %s as %s', (condition, expected) => {
    expect(evaluate(condition, context)).toBe(expected);
  });

  it('refuses an expression it does not know, so a new kind of condition cannot pass unread', () => {
    expect(() => evaluate("contains(github.ref, 'x')", context)).toThrow();
  });
});
