import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { login } from './helpers.js';

// Helpers for the browser-session tests. Any test that ends sessions (logout, logout-all, a password
// change, reuse, the limits) must use its own account from createTestAccount(), never `admin`: test
// files run in parallel and ending admin's sessions would break the others.

export interface TestAccount {
  username: string;
  password: string;
}

export async function createTestAccount(baseUrl: string): Promise<TestAccount> {
  const token = await login(baseUrl);
  const username = `m6-test-${randomUUID()}`;
  const password = `pw-${randomUUID()}`.slice(0, 40);
  const res = await fetch(`${baseUrl}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 201) throw new Error(`Could not create a test account: status ${res.status}`);
  return { username, password };
}

export interface ParsedCookie {
  name: string;
  value: string;
  attributes: Record<string, string | true>;
}

export function parseSetCookie(header: string): ParsedCookie {
  const [pair = '', ...rest] = header.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  const attributes: Record<string, string | true> = {};
  for (const part of rest) {
    const at = part.indexOf('=');
    if (at === -1) attributes[part.toLowerCase()] = true;
    else attributes[part.slice(0, at).toLowerCase()] = part.slice(at + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes };
}

export interface SessionRequestOptions {
  cookie?: string;
  body?: unknown;
  // Defaults to the server's own origin. Pass null to send no Origin header at all.
  origin?: string | null;
  contentType?: string;
  headers?: Record<string, string>;
  method?: string;
}

// What a successful sign-in or renewal answers. The body of any other status has a different shape
// ({ error } or none), which tests assert with toEqual.
export interface SessionBody {
  access_token: string;
  expires_at: string;
  account: { id: number; username: string };
}

export interface SessionResponse {
  status: number;
  body: SessionBody;
  headers: Headers;
  setCookie: ParsedCookie | null;
}

export async function sessionRequest(
  baseUrl: string,
  path: string,
  options: SessionRequestOptions = {},
): Promise<SessionResponse> {
  const headers: Record<string, string> = {
    'Content-Type': options.contentType ?? 'application/json',
    ...options.headers,
  };
  const origin = options.origin === undefined ? baseUrl : options.origin;
  if (origin !== null) headers.Origin = origin;
  if (options.cookie !== undefined) headers.Cookie = `scrylux_session=${options.cookie}`;

  const res = await fetch(`${baseUrl}/api/session${path}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
  });
  const text = await res.text();
  const header = res.headers.getSetCookie().find((c) => c.startsWith('scrylux_session='));
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as SessionBody,
    headers: res.headers,
    setCookie: header ? parseSetCookie(header) : null,
  };
}

export interface SignedIn {
  accessToken: string;
  cookie: string;
  body: SessionBody;
}

export async function signIn(baseUrl: string, account: TestAccount, headers?: Record<string, string>): Promise<SignedIn> {
  const res = await sessionRequest(baseUrl, '', { body: account, headers });
  if (res.status !== 200 || !res.setCookie) throw new Error(`Test sign-in failed with status ${res.status}`);
  return { accessToken: res.body.access_token, cookie: res.setCookie.value, body: res.body };
}

export interface SessionLogCapture {
  // Parsed log lines whose event is "session".
  lines: () => Record<string, unknown>[];
  // Every string written with console.log, so a test can assert that a secret appears in none of them.
  raw: () => string[];
  restore: () => void;
}

export function captureSessionLog(): SessionLogCapture {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const raw = (): string[] => spy.mock.calls.map((call) => call.map(String).join(' '));
  return {
    raw,
    lines: () =>
      raw()
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === 'session'),
    restore: () => spy.mockRestore(),
  };
}
