import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export interface V1Client {
  get<T = unknown>(path: string): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  del(path: string): Promise<ApiResponse<null>>;
  // For requests the typed helpers can't express: a raw body, or a different token.
  raw(path: string, init: RequestInit): Promise<ApiResponse>;
}

// Requests against `${baseUrl}/api/v1${path}` with the given token. Each call resolves to the status
// and the parsed JSON body, or null for an empty one.
export function client(baseUrl: string, token: string): V1Client {
  async function send<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    return raw(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    }) as Promise<ApiResponse<T>>;
  }
  async function raw(path: string, init: RequestInit): Promise<ApiResponse> {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
  }
  return {
    get: (path) => send('GET', path),
    post: (path, body = {}) => send('POST', path, body),
    patch: (path, body = {}) => send('PATCH', path, body),
    del: (path) => send<null>('DELETE', path),
    raw,
  };
}

// The account a token was issued to: its `sub` claim.
export function accountIdOf(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub: string };
  return Number(payload.sub);
}

// Names must be unique: the test database is shared across files and project names are unique.
export function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID()}`;
}

export interface ApiRecord {
  id: string;
  [key: string]: unknown;
}

export interface Chain {
  project: ApiRecord;
  model: ApiRecord;
  nodeA: ApiRecord;
  nodeB: ApiRecord;
  flow: ApiRecord;
  threat: ApiRecord;
  mitigation: ApiRecord;
}

// A project with a threat model, two process elements, a data flow between them, a threat on the
// first element and a mitigation on that threat, all created through the API.
export async function seedChain(c: V1Client): Promise<Chain> {
  const project = (await c.post<ApiRecord>('/projects', { name: uniqueName('Chain') })).body;
  const model = (await c.post<ApiRecord>('/threat-models', { project_id: project.id, name: 'Model' })).body;
  const nodeA = (await c.post<ApiRecord>('/elements', { threat_model_id: model.id, type: 'process', name: 'A' })).body;
  const nodeB = (await c.post<ApiRecord>('/elements', { threat_model_id: model.id, type: 'process', name: 'B' })).body;
  const flow = (
    await c.post<ApiRecord>('/elements', {
      threat_model_id: model.id,
      type: 'data_flow',
      name: 'A to B',
      source_element_id: nodeA.id,
      target_element_id: nodeB.id,
    })
  ).body;
  const threat = (
    await c.post<ApiRecord>('/threats', {
      threat_model_id: model.id,
      element_id: nodeA.id,
      category: 'Tampering',
      title: 'Altered payload',
      likelihood: 'Medium',
      impact: 'High',
      origin: 'manual',
    })
  ).body;
  const mitigation = (await c.post<ApiRecord>('/mitigations', { threat_id: threat.id, description: 'Sign payloads' })).body;
  return { project, model, nodeA, nodeB, flow, threat, mitigation };
}

export interface WriteLogLine {
  event: 'write';
  account_id: number;
  action: 'create' | 'update' | 'delete';
  type: 'project' | 'threat_model' | 'element' | 'threat' | 'mitigation' | 'asset' | 'assumption';
  id: string;
}

// Collects the write log lines printed while it is active. Other console output passes through.
export function captureWriteLog(): { lines: () => WriteLogLine[]; raw: () => string[]; restore: () => void } {
  const original = console.log;
  const printed: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    printed.push(line);
    if (!line.startsWith('{"event":"write"')) original(...args);
  });
  return {
    lines: () => printed.filter((l) => l.startsWith('{"event":"write"')).map((l) => JSON.parse(l) as WriteLogLine),
    raw: () => [...printed],
    restore: () => spy.mockRestore(),
  };
}
