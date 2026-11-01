import type { z } from 'zod';
import { ApiError, toApiError } from './errors.js';
import { emitSessionEnded, getAccessToken, renew, tokenNeedsRenewal } from './session.js';

// The API client (research #5, #15). Every call carries the in-memory access token as a bearer header.
// When the token is missing or nearly expired, it is renewed first. After a 401 it is renewed once and
// the request is retried once. If that fails too, the session has ended and the app is told so.

// A failed renewal ends the session only when the server says it is gone (401). Any other failure,
// such as a 500 or a lost connection, is just an error: the session may still be fine.
async function renewOrEnd(): Promise<void> {
  try {
    await renew();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) emitSessionEnded();
    throw err;
  }
}

function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${getAccessToken() ?? ''}`);
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (tokenNeedsRenewal()) await renewOrEnd();
  let res = await send(path, init);
  if (res.status === 401) {
    await renewOrEnd();
    res = await send(path, init);
    if (res.status === 401) {
      emitSessionEnded();
      throw await toApiError(res);
    }
  }
  return res;
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await apiFetch(path, init);
  if (!res.ok) throw await toApiError(res);
  return res;
}

// Success bodies are parsed with the shared record schemas, so what the UI shows is what the contract
// says (spec FR-011).
export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await (await request('GET', path)).json());
}

export async function apiPost<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
  return schema.parse(await (await request('POST', path, body)).json());
}

export async function apiPatch<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
  return schema.parse(await (await request('PATCH', path, body)).json());
}

export async function apiDelete(path: string): Promise<void> {
  await request('DELETE', path);
}

// A multipart upload (Phase 3 Milestone 3): the browser sets the content type, with the boundary, so none is set here.
export async function apiPostForm<T>(path: string, schema: z.ZodType<T>, form: FormData): Promise<T> {
  const res = await apiFetch(path, { method: 'POST', body: form });
  if (!res.ok) throw await toApiError(res);
  return schema.parse(await res.json());
}
