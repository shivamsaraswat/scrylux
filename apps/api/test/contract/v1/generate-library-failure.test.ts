import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LibraryLoadError } from '@scrylux/threat-library';
import app from '../../../src/app.js';
import { login, startTestServer, type TestServer } from '../helpers.js';
import { captureWriteLog, client, uniqueName, type ApiRecord, type V1Client } from './helpers.js';

// Spec edge case "The library fails to load": generation reports an error and changes nothing; it never
// runs with part of the library (Milestone 2, FR-013). The shipped library is made to fail the way a broken
// rule file would. This file mocks it, so it stays apart from the tests that need the real one.
const library = vi.hoisted(() => ({ fail: true }));

vi.mock('@scrylux/threat-library', async (importOriginal) => {
  const original = await importOriginal<typeof import('@scrylux/threat-library')>();
  return {
    ...original,
    shippedLibrary: () => {
      if (library.fail) {
        throw new original.LibraryLoadError([{ file: 'process/p-broken.yaml', rule: 'p-broken', message: 'title: must not be empty' }]);
      }
      return original.shippedLibrary();
    },
  };
});

describe('generating threats when the threat library fails to load', () => {
  let server: TestServer;
  let c: V1Client;

  beforeAll(async () => {
    server = await startTestServer(app);
    c = client(server.baseUrl, await login(server.baseUrl));
  });

  afterAll(async () => {
    await server.close();
  });

  it('answers a generic 500, writes nothing and logs no run, then works again once the library loads', async () => {
    const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Library failure') })).body;
    const model = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body;
    await c.post('/elements', { threat_model_id: model.id, type: 'process', name: 'Orders API' });

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = captureWriteLog();
    try {
      library.fail = true;
      const res = await c.post(`/threat-models/${model.id}/threats/generate`, {});
      expect(res.status).toBe(500);
      // The response never carries the library's own message, which names rule files.
      expect(res.body).toEqual({ error: 'Internal server error' });
      // The details go to the server log only.
      expect(errors.mock.calls.flat().some((arg) => arg instanceof LibraryLoadError)).toBe(true);
      expect(log.raw().filter((line) => line.includes('"event":"generate"'))).toEqual([]);
      expect(log.lines()).toEqual([]);

      expect((await c.get<unknown[]>(`/threat-models/${model.id}/threats`)).body).toEqual([]);
      expect((await c.get<unknown[]>(`/threat-models/${model.id}/mitigations`)).body).toEqual([]);

      library.fail = false;
      const again = await c.post<{ created: number }>(`/threat-models/${model.id}/threats/generate`, {});
      expect(again.status).toBe(200);
      expect(again.body.created).toBeGreaterThan(0);
    } finally {
      log.restore();
      errors.mockRestore();
      library.fail = false;
    }
  });
});
