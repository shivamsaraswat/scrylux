import { request as httpRequest, type ClientRequest } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { SourceList, SourceRecord } from '@scrylux/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../../src/app.js';
import db from '../../../src/db.js';
import { storage } from '../../../src/storage/instance.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { accountIdOf, client, type V1Client } from './helpers.js';
import { LOCAL_PROVIDER, createAccount } from './jobs-helpers.js';
import { docx } from '../../fixtures/sources/zip.js';
import { pdf } from '../../fixtures/sources/pdf.js';

// The routes that add and list sources (Phase 3 Milestone 3, contracts/http-api.md): upload, paste and list, with every refusal
// they can make. Reading a source, its chunks, deleting, retrying and refreshing have files of their own. The API only checks a
// file's first bytes and stores it; the worker reads it. Nothing in this file needs a worker: a source simply waits.

const EMBEDDINGS = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_MODEL: 'nomic-embed-text',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:9/v1',
  EMBEDDING_LOCAL: 'true',
} as const;

describe('/api/v1 sources (FR-001 to FR-009, FR-043, FR-060)', () => {
  let server: TestServer;
  let c: V1Client;
  let token: string;
  let threatModel: string;

  beforeAll(async () => {
    server = await startTestServer(app);
    token = await login(server.baseUrl);
    c = client(server.baseUrl, token);
  });
  afterAll(async () => {
    await server.close();
  });

  beforeEach(async () => {
    for (const [name, value] of Object.entries({ ...LOCAL_PROVIDER, ...EMBEDDINGS, JOBS_PER_ACCOUNT: '100', PROVIDER_CHECK_COOLDOWN: '0' })) vi.stubEnv(name, value);
    await db.query('TRUNCATE jobs, job_usage, workers, sources CASCADE');
    for await (const item of storage().list()) await storage().delete(item.key);
    const project = (await c.post<{ id: string }>('/projects', { name: `p-${randomUUID()}` })).body;
    threatModel = (await c.post<{ id: string }>('/threat-models', { project_id: project.id, name: 'model' })).body.id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const form = (bytes: Uint8Array, name: string, field = 'file'): FormData => {
    const data = new FormData();
    data.append(field, new Blob([new Uint8Array(bytes)]), name);
    return data;
  };
  const upload = async (bytes: Uint8Array | string, name = 'design.md', tm = threatModel, auth = token) => {
    const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${tm}/sources`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}` },
      body: form(typeof bytes === 'string' ? Buffer.from(bytes) : bytes, name),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : null) as { error?: string } & Record<string, unknown> };
  };
  const paste = (body: unknown, tm = threatModel) => c.post(`/threat-models/${tm}/sources/text`, body);
  const keysInStorage = async (): Promise<string[]> => {
    const keys: string[] = [];
    for await (const item of storage().list()) keys.push(item.key);
    return keys;
  };
  const markdown = (text: string = randomUUID()): Buffer => Buffer.from(`# Design\n\n${text}\n`);

  describe('POST /threat-models/{id}/sources', () => {
    it('adds the source at once, waiting, and queues its ingestion job (FR-001, FR-040)', async () => {
      const res = await upload(markdown('The gateway forwards each request.'));
      expect(res.status).toBe(201);
      const source = SourceRecord.parse(res.body);
      expect(source).toMatchObject({ name: 'design.md', type: 'md', status: 'waiting', threat_model_id: threatModel, ready: null, failure: null });
      const { rows } = await db.query<Record<string, unknown>>(`SELECT kind, state, source_id, threat_model_id FROM jobs`);
      expect(rows).toEqual([{ kind: 'ingest_source', state: 'queued', source_id: source.id, threat_model_id: threatModel }]);
      expect(await keysInStorage()).toHaveLength(1);
    });

    it.each([
      ['a PDF', () => pdf({ pages: ['text'] }), 'design.pdf', 'pdf'],
      ['a Word file', () => docx({ blocks: [{ paragraph: 'text' }] }), 'design.docx', 'docx'],
      ['a text file', () => markdown(), 'notes.txt', 'txt'],
    ])('adds %s as the type its content and its name agree on', async (_label, build, name, type) => {
      const res = await upload(build(), name);
      expect(res.status).toBe(201);
      expect(res.body.type).toBe(type);
    });

    it('keeps a name with characters outside ASCII as it was sent (research #9)', async () => {
      const res = await upload(markdown(), 'Entwurf für Zürich — 日本語.md');
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Entwurf für Zürich — 日本語.md');
    });

    it('lists the source and the limits afterwards, and a source added by another account is listed too (FR-065)', async () => {
      await upload(markdown());
      const other = await createAccount(server.baseUrl, token);
      const added = await upload(markdown(), 'other.md', threatModel, other.token);
      expect(added.status).toBe(201);
      const list = SourceList.parse((await c.get(`/threat-models/${threatModel}/sources`)).body);
      expect(list.sources.map((s) => s.name)).toEqual(['design.md', 'other.md']);
      expect(list.sources[1]?.added_by.id).toBe(other.id);
      expect(list.limits).toMatchObject({ max_bytes: 10 * 1024 * 1024, per_threat_model: 20, document_space_bytes: 2 * 1024 ** 3 });
    });

    describe('400: the request or the file is not one that can be added', () => {
      it.each([
        ['a file of nothing', () => upload(Buffer.alloc(0)), /empty/i],
        ['text that is not UTF-8', () => upload(Buffer.from([0x63, 0x61, 0x66, 0xe9])), /UTF-8/],
        ['text with a NUL', () => upload(Buffer.from('before\u0000after')), /NUL/],
        ['a name of 256 characters', () => upload(markdown(), `${'a'.repeat(253)}.md`), /255 characters/],
        ['a name with a control character', () => upload(markdown(), 'no\u0085te.md'), /control character/],
        ['a name with no supported extension', () => upload(markdown(), 'notes.rtf'), /\.md, \.txt, \.pdf or \.docx/],
        ['the older Word format', () => upload(markdown(), 'notes.doc'), /\.docx/],
      ])('refuses %s, stores nothing and queues nothing', async (_label, send, message) => {
        const res = await send();
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(message);
        expect(await keysInStorage()).toEqual([]);
        expect((await db.query('SELECT 1 FROM jobs')).rows).toEqual([]);
      });

      it('never repeats the name it refuses', async () => {
        const res = await upload(markdown(), 'confidential-merger\u0085.md');
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).not.toContain('confidential');
      });

      it('refuses a body that is not multipart, one with no file part, one with another part, and one with two files', async () => {
        const url = `${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`;
        const auth = { Authorization: `Bearer ${token}` };
        expect((await fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
        const wrong = new FormData();
        wrong.append('document', new Blob([new Uint8Array(markdown())]), 'a.md');
        expect((await fetch(url, { method: 'POST', headers: auth, body: wrong })).status).toBe(400);
        const field = form(markdown(), 'a.md');
        field.append('note', 'an extra field');
        expect((await fetch(url, { method: 'POST', headers: auth, body: field })).status).toBe(400);
        const two = form(markdown(), 'a.md');
        two.append('file', new Blob([new Uint8Array(markdown())]), 'b.md');
        expect((await fetch(url, { method: 'POST', headers: auth, body: two })).status).toBe(400);
        expect(await keysInStorage()).toEqual([]);
      });
    });

    describe('415: the first bytes are not those of the type the name says', () => {
      it.each([
        ['a text file named .pdf', () => upload(markdown(), 'design.pdf'), 'This file is not a PDF.'],
        ['a PDF named .docx', () => upload(pdf({ pages: ['x'] }), 'design.docx'), 'This file is not a Word .docx file.'],
        ['an encrypted Word file or the older format named .docx', () => upload(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'design.docx'), 'This is an encrypted Word file or an older .doc. Upload an unprotected .docx.'],
      ])('refuses %s', async (_label, send, message) => {
        const res = await send();
        expect(res.status).toBe(415);
        expect(res.body.error).toBe(message);
        expect(await keysInStorage()).toEqual([]);
      });
    });

    describe('409', () => {
      it('refuses when no embedding provider is configured, with generation configured, and stores nothing (FR-030)', async () => {
        vi.stubEnv('EMBEDDING_PROVIDER', '');
        vi.stubEnv('EMBEDDING_MODEL', '');
        vi.stubEnv('EMBEDDING_BASE_URL', '');
        vi.stubEnv('EMBEDDING_LOCAL', '');
        const res = await upload(markdown());
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('Adding documents needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER.');
        expect(await keysInStorage()).toEqual([]);
      });

      it('refuses when nothing at all is configured', async () => {
        for (const name of [...Object.keys(EMBEDDINGS), ...Object.keys(LOCAL_PROVIDER)]) vi.stubEnv(name, '');
        expect((await upload(markdown())).status).toBe(409);
      });

      it('refuses the same content twice, naming the source already there (FR-006)', async () => {
        const content = markdown('twice');
        await upload(content, 'first.md');
        const res = await upload(content, 'second.md');
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('This document is already a source of this threat model: first.md.');
        expect(await keysInStorage()).toHaveLength(1);
      });

      it('refuses a source past the limit for a threat model (FR-005)', async () => {
        vi.stubEnv('SOURCES_PER_THREAT_MODEL', '2');
        await upload(markdown());
        await upload(markdown());
        const res = await upload(markdown());
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('This threat model already has 2 sources, the most allowed.');
        expect(await keysInStorage()).toHaveLength(2);
      });
    });

    describe('413: the file is larger than the limit (FR-004)', () => {
      it('refuses a file whose announced size is over, before reading it', async () => {
        vi.stubEnv('SOURCE_MAX_MB', '1');
        const res = await upload(Buffer.alloc(1024 * 1024 + 32 * 1024, 0x61));
        expect(res.status).toBe(413);
        expect(res.body.error).toBe('The file is larger than 1 MB, the most allowed.');
        expect(await keysInStorage()).toEqual([]);
      });

      it('refuses a file that turns out larger while it arrives, which sent no length', async () => {
        vi.stubEnv('SOURCE_MAX_MB', '1');
        const boundary = `b${randomUUID().replaceAll('-', '')}`;
        const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.md"\r\nContent-Type: text/markdown\r\n\r\n`);
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const url = new URL(`${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`);
          const req = httpRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked' } }, (response) => {
            const parts: Buffer[] = [];
            response.on('data', (part: Buffer) => parts.push(part));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts).toString() }));
          });
          req.on('error', (error) => (/ECONNRESET|EPIPE/.test(error.message) ? undefined : reject(error)));
          req.write(head);
          for (let i = 0; i < 24; i++) req.write(Buffer.alloc(64 * 1024, 0x61));
          req.end(tail);
        });
        expect(res.status).toBe(413);
        expect(await keysInStorage()).toEqual([]);
      });
    });

    describe('429 and 507', () => {
      it('refuses an account’s ingestion job past its limit, says when to try again, and leaves nothing behind (FR-043)', async () => {
        vi.stubEnv('INGESTION_JOBS_PER_ACCOUNT', '1');
        await upload(markdown());
        const res = await upload(markdown());
        expect(res.status).toBe(429);
        expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
        expect(res.body.error).toBe('You already have 1 document being processed. Wait for one to finish.');
        expect(await keysInStorage()).toHaveLength(1);
        expect((await db.query('SELECT 1 FROM sources')).rows).toHaveLength(1);
      });

      it('does not count the limit of the Jobs page against documents, nor documents against it (FR-043)', async () => {
        vi.stubEnv('JOBS_PER_ACCOUNT', '1');
        expect((await c.post('/jobs', { kind: 'provider_check', input: {} })).status).toBe(201);
        expect((await upload(markdown())).status).toBe(201);
        expect((await upload(markdown())).status).toBe(201);
      });

      it('refuses a source that would pass the install’s document space (FR-009), and stores nothing', async () => {
        vi.stubEnv('DOCUMENT_SPACE', '100MB');
        const cap = 100 * 1024 * 1024;
        await db.query(
          `INSERT INTO sources (threat_model_id, name, type, size_bytes, digest, added_by, stored_bytes, ready_at, text_chars, chunk_count, embedding_model, embedding_dimension)
           VALUES ($1, 'full.md', 'md', 1000, $2, $3, $4, now(), 10, 1, 'nomic-embed-text', 3)`,
          [threatModel, randomBytes(32), accountIdOf(token), cap - 100],
        );
        const res = await upload(Buffer.alloc(300, 0x61));
        expect(res.status).toBe(507);
        expect(res.body.error).toContain('document space');
        expect(await keysInStorage()).toEqual([]);
      });
    });

    describe('what is answered before the file is read', () => {
      /** A request whose body never ends: headers and the start of a file, then silence. Resolves with the status it was answered with. */
      function held(path: string, hold: ClientRequest[], contentType: string, first: Buffer): Promise<number | 'open'> {
        return new Promise((resolve, reject) => {
          const req = httpRequest(new URL(`${server.baseUrl}/api/v1${path}`), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType, 'Transfer-Encoding': 'chunked' } }, (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          });
          req.on('error', () => resolve('open'));
          hold.push(req);
          req.write(first);
          setTimeout(() => resolve('open'), 400);
          void reject;
        });
      }
      const multipartStart = (): { type: string; first: Buffer } => {
        const boundary = `b${randomUUID().replaceAll('-', '')}`;
        return { type: `multipart/form-data; boundary=${boundary}`, first: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.md"\r\n\r\npartial`) };
      };
      const open: ClientRequest[] = [];
      afterEach(() => {
        for (const req of open.splice(0)) req.destroy();
      });

      it('answers 404 for a threat model that is not there while the body is still arriving', async () => {
        const { type, first } = multipartStart();
        expect(await held(`/threat-models/${randomUUID()}/sources`, open, type, first)).toBe(404);
      });

      it('answers 409 for a feature that is not configured while the body is still arriving', async () => {
        for (const name of Object.keys(EMBEDDINGS)) vi.stubEnv(name, '');
        const { type, first } = multipartStart();
        expect(await held(`/threat-models/${threatModel}/sources`, open, type, first)).toBe(409);
      });

      it('answers 503 to a fifth upload while four are being read, and to a paste, then accepts one again when they have gone (FR-004)', async () => {
        for (let i = 0; i < 4; i++) {
          const { type, first } = multipartStart();
          expect(await held(`/threat-models/${threatModel}/sources`, open, type, first)).toBe('open');
        }
        const fifth = await upload(markdown());
        expect(fifth.status).toBe(503);
        expect(fifth.headers.get('retry-after')).toBe('5');
        expect(fifth.body.error).toBe('Scrylux is busy reading other uploads. Try again in a few seconds.');
        const pasted = await paste({ title: 'notes', text: 'some text' });
        expect(pasted.status).toBe(503);
        expect(await keysInStorage()).toEqual([]);

        for (const req of open.splice(0)) req.destroy();
        const again = await vi.waitFor(async () => {
          const res = await upload(markdown());
          if (res.status === 503) throw new Error('still busy');
          return res;
        }, { timeout: 5000, interval: 50 });
        expect(again.status).toBe(201);
      });
    });

    it('answers 404 for a threat model that is not there, and 400 for an id that is not one', async () => {
      expect((await upload(markdown(), 'design.md', randomUUID())).status).toBe(404);
      expect((await upload(markdown(), 'design.md', 'not-a-uuid')).status).toBe(400);
    });

    it('needs a signed-in account', async () => {
      const res = await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`, { method: 'POST', body: form(markdown(), 'a.md') });
      expect(res.status).toBe(401);
      expect((await fetch(`${server.baseUrl}/api/v1/threat-models/${threatModel}/sources`)).status).toBe(401);
    });

    it('writes one log line for an add, with the account, the source, the type and the size, and never the name (FR-061)', async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => void lines.push(String(line)));
      const content = markdown('CANARY-TEXT');
      const res = await upload(content, 'confidential-merger-plan.md');
      spy.mockRestore();
      const entries = lines.flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } }).filter((l) => l.event === 'source');
      expect(entries).toEqual([{ event: 'source', action: 'add', account: accountIdOf(token), source: res.body.id, threat_model: threatModel, type: 'md', size_bytes: content.length }]);
      expect(lines.join('\n')).not.toContain('confidential');
      expect(lines.join('\n')).not.toContain('CANARY');
    });
  });

  describe('POST /threat-models/{id}/sources/text', () => {
    it('adds the pasted text as a source of type text, named by its title', async () => {
      const res = await paste({ title: '  Architecture notes ', text: 'The API talks to the database.' });
      expect(res.status).toBe(201);
      expect(SourceRecord.parse(res.body)).toMatchObject({ name: 'Architecture notes', type: 'text', status: 'waiting', size_bytes: 30 });
      expect(await keysInStorage()).toHaveLength(1);
    });

    it.each([
      ['a title of 201 characters', { title: 'a'.repeat(201), text: 'x' }],
      ['a blank title', { title: '   ', text: 'x' }],
      ['a text of only spaces', { title: 't', text: ' \n ' }],
      ['a field it does not name', { title: 't', text: 'x', type: 'pdf' }],
      ['no text', { title: 't' }],
      ['a text with a NUL', { title: 't', text: 'a\u0000b' }],
    ])('refuses %s with 400', async (_label, body) => {
      const res = await paste(body);
      expect(res.status).toBe(400);
      expect(await keysInStorage()).toEqual([]);
    });

    it('refuses a body that is not JSON, and one that is not valid JSON', async () => {
      const url = `${server.baseUrl}/api/v1/threat-models/${threatModel}/sources/text`;
      expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: 'hello' })).status).toBe(415);
      expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{not json' })).status).toBe(400);
    });

    it('refuses a text larger than the limit, by its size in UTF-8 and not by its characters (FR-004)', async () => {
      vi.stubEnv('SOURCE_MAX_MB', '1');
      expect((await paste({ title: 't', text: 'é'.repeat(600_000) })).status).toBe(413);
      expect((await paste({ title: 't', text: 'a'.repeat(1024 * 1024 + 1) })).status).toBe(413);
      expect((await paste({ title: 't', text: 'a'.repeat(1024 * 1024) })).status).toBe(201);
    });

    it('refuses the same text twice, and the same text as an uploaded .txt file (FR-006)', async () => {
      expect((await paste({ title: 'one', text: 'same text' })).status).toBe(201);
      const again = await paste({ title: 'two', text: 'same text' });
      expect(again.status).toBe(409);
      expect((again.body as { error: string }).error).toContain('one');
      expect((await upload('same text', 'notes.txt')).status).toBe(409);
    });

    it('refuses when no embedding provider is configured, and for a threat model that is not there', async () => {
      expect((await paste({ title: 't', text: 'x' }, randomUUID())).status).toBe(404);
      for (const name of Object.keys(EMBEDDINGS)) vi.stubEnv(name, '');
      expect((await paste({ title: 't', text: 'x' })).status).toBe(409);
    });
  });

  describe('GET /threat-models/{id}/sources', () => {
    it('lists nothing for a threat model without sources, 404 for one that is not there and 400 for a bad id', async () => {
      expect(SourceList.parse((await c.get(`/threat-models/${threatModel}/sources`)).body).sources).toEqual([]);
      expect((await c.get(`/threat-models/${randomUUID()}/sources`)).status).toBe(404);
      expect((await c.get('/threat-models/not-a-uuid/sources')).status).toBe(400);
    });

    it('answers with no key, path, bucket or digest of a stored original (FR-068)', async () => {
      await upload(markdown());
      const text = JSON.stringify((await c.get(`/threat-models/${threatModel}/sources`)).body);
      expect(text).not.toMatch(/original_key|sources\/[0-9a-f-]{36}|digest|bucket/);
    });
  });

  describe('the job routes', () => {
    it('refuses to start an ingestion or a refresh through POST /jobs, which only the source routes may queue (FR-045a, SC-012)', async () => {
      for (const kind of ['ingest_source', 'refresh_embeddings']) expect((await c.post('/jobs', { kind, input: {} })).status).toBe(400);
      expect((await c.post('/jobs', { kind: 'ingest_source', source_id: randomUUID() })).status).toBe(400);
      expect((await db.query('SELECT 1 FROM jobs')).rows).toEqual([]);
    });

    it('shows the threat model and the source of an ingestion job, and null for a provider check', async () => {
      const added = await upload(markdown());
      await c.post('/jobs', { kind: 'provider_check', input: {} });
      const jobs = (await c.get<{ jobs: { kind: string; threat_model_id: string | null; source_id: string | null }[] }>('/jobs')).body.jobs;
      expect(jobs.find((j) => j.kind === 'ingest_source')).toMatchObject({ threat_model_id: threatModel, source_id: added.body.id });
      expect(jobs.find((j) => j.kind === 'provider_check')).toMatchObject({ threat_model_id: null, source_id: null });
    });
  });
});
