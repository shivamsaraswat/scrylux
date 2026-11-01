import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, newOriginalKey, type Storage } from '../../src/storage/index.js';
import { startS3Stub, type S3Stub } from './s3-stub.js';

// The IAM policies in docs/install.md ("Storage") are enough for what each process does with the bucket, and give it nothing more
// (Phase 3 Milestone 3, Principle V, research #10). It reads the two policies out of the documentation, runs what the app does
// (put, delete) and what the worker does (get, delete, list) against the S3 stub, and checks every request the AWS client made
// against the policy of that process by the rules of IAM: an action and a resource, and for a list the `s3:prefix` condition. A
// request no statement allows is a request the documented policy would refuse on AWS; an action a statement allows that the
// process never used is more access than it needs.

const BUCKET = 'my-bucket';
const DOC = readFileSync(fileURLToPath(new URL('../../../../docs/install.md', import.meta.url)), 'utf8');

interface Statement {
  Effect: 'Allow';
  Action: string | string[];
  Resource: string;
  Condition?: { StringLike?: Record<string, string> };
}
interface Policy {
  Statement: Statement[];
}

/** The two JSON policies of the Storage section, in the order the text gives them: the app's, then the worker's. */
function documentedPolicies(): { app: Policy; worker: Policy } {
  const section = DOC.slice(DOC.indexOf('### Storage'), DOC.indexOf('### The document space'));
  const blocks = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1] as string) as Policy);
  expect(blocks).toHaveLength(2);
  return { app: blocks[0] as Policy, worker: blocks[1] as Policy };
}

const like = (pattern: string, value: string): boolean => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);

interface Call {
  action: 's3:PutObject' | 's3:GetObject' | 's3:DeleteObject' | 's3:ListBucket';
  resource: string;
  prefix?: string;
}

/** What an S3 request is to IAM. Anything this does not know is returned as undefined, and fails the test that sees it. */
function asCall(request: string): Call | undefined {
  const [method, rest] = request.split(' ') as [string, string];
  const url = new URL(rest, 'http://stub');
  const path = decodeURIComponent(url.pathname);
  if (path === `/${BUCKET}` || path === `/${BUCKET}/`) {
    return method === 'GET' && url.searchParams.get('list-type') === '2' ? { action: 's3:ListBucket', resource: `arn:aws:s3:::${BUCKET}`, prefix: url.searchParams.get('prefix') ?? '' } : undefined;
  }
  const key = path.slice(`/${BUCKET}/`.length);
  const resource = `arn:aws:s3:::${BUCKET}/${key}`;
  if (method === 'PUT') return { action: 's3:PutObject', resource };
  if (method === 'GET') return { action: 's3:GetObject', resource };
  if (method === 'DELETE') return { action: 's3:DeleteObject', resource };
  return undefined;
}

function allowed(policy: Policy, call: Call): boolean {
  return policy.Statement.some((statement) => {
    if (statement.Effect !== 'Allow') return false;
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    if (!actions.includes(call.action) || !like(statement.Resource, call.resource)) return false;
    const prefixes = statement.Condition?.StringLike?.['s3:prefix'];
    return prefixes === undefined || (call.prefix !== undefined && like(prefixes, call.prefix));
  });
}

let stub: S3Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

async function storageOnStub(): Promise<Storage> {
  stub = await startS3Stub(BUCKET);
  return createStorage({ backend: 's3', bucket: BUCKET, prefix: 'scrylux/', region: 'us-east-1', endpoint: stub.endpoint, forcePathStyle: true, accessKeyId: 'AKIAFAKEACCESSKEY', secretAccessKey: 'fake-secret-access-key' });
}

describe('the IAM policies in docs/install.md', () => {
  it('are two policies with no wildcard action and no resource beyond the prefix', () => {
    const { app, worker } = documentedPolicies();
    for (const statement of [...app.Statement, ...worker.Statement]) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      expect(actions.every((a) => /^s3:[A-Za-z]+$/.test(a))).toBe(true);
      expect(statement.Resource).toMatch(/^arn:aws:s3:::my-bucket(\/scrylux\/sources\/\*)?$/);
    }
  });

  it('allow every request the app makes to store and remove an original, and the app makes no other', async () => {
    const storage = await storageOnStub();
    const key = newOriginalKey();
    await storage.put(key, Buffer.from('a document'));
    await storage.delete(key);
    await storage.delete(newOriginalKey());
    const calls = (stub?.requestsWithQuery ?? []).map((request) => ({ request, call: asCall(request) }));
    expect(calls.length).toBeGreaterThan(0);
    const { app } = documentedPolicies();
    for (const { request, call } of calls) {
      expect(call, `${request} is a request IAM can place`).toBeDefined();
      expect(allowed(app, call as Call), `${request} is allowed by the app's policy`).toBe(true);
    }
    // Nothing the policy grants goes unused, and nothing it withholds is needed.
    expect(new Set(calls.map(({ call }) => call?.action))).toEqual(new Set(['s3:PutObject', 's3:DeleteObject']));
  });

  it('allow every request the worker makes to read, list and remove originals, and the worker makes no other', async () => {
    const storage = await storageOnStub();
    const key = newOriginalKey();
    // The app put it; the worker reads it, sweeps the prefix and removes it.
    stub?.seed(`scrylux/${key}`, 'a document');
    stub?.seed(`scrylux/sources/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, 'orphan', new Date(0));
    await storage.get(key);
    const listed: string[] = [];
    for await (const item of storage.list()) listed.push(item.key);
    expect(listed).toHaveLength(2);
    await storage.delete(key);
    const calls = (stub?.requestsWithQuery ?? []).map((request) => ({ request, call: asCall(request) }));
    const { worker } = documentedPolicies();
    for (const { request, call } of calls) {
      expect(call, `${request} is a request IAM can place`).toBeDefined();
      expect(allowed(worker, call as Call), `${request} is allowed by the worker's policy`).toBe(true);
    }
    expect(new Set(calls.map(({ call }) => call?.action))).toEqual(new Set(['s3:GetObject', 's3:ListBucket', 's3:DeleteObject']));
  });

  it('do not let one process do what only the other needs', () => {
    const { app, worker } = documentedPolicies();
    const original = `arn:aws:s3:::${BUCKET}/scrylux/sources/00000000-0000-4000-8000-000000000000`;
    expect(allowed(app, { action: 's3:GetObject', resource: original })).toBe(false);
    expect(allowed(app, { action: 's3:ListBucket', resource: `arn:aws:s3:::${BUCKET}`, prefix: 'scrylux/sources/' })).toBe(false);
    expect(allowed(worker, { action: 's3:PutObject', resource: original })).toBe(false);
    // And neither reaches an object of another prefix, or lists another prefix, of a shared bucket.
    for (const policy of [app, worker]) {
      expect(allowed(policy, { action: 's3:DeleteObject', resource: `arn:aws:s3:::${BUCKET}/other/thing` })).toBe(false);
    }
    expect(allowed(worker, { action: 's3:GetObject', resource: `arn:aws:s3:::${BUCKET}/other/thing` })).toBe(false);
    expect(allowed(worker, { action: 's3:ListBucket', resource: `arn:aws:s3:::${BUCKET}`, prefix: 'other/' })).toBe(false);
    expect(allowed(worker, { action: 's3:ListBucket', resource: `arn:aws:s3:::${BUCKET}`, prefix: '' })).toBe(false);
  });
});
