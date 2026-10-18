import { z } from 'zod';
import { toApiError } from './errors.js';

// The browser session client (spec FR-002 to FR-005, research #3, #5). The long-lived credential is an
// HttpOnly cookie that scripts cannot read. What this module holds is the short-lived access token,
// only in the variables below: never in Web Storage, a URL or a log. It is renewed through the cookie
// only when a request is about to go out and the token is missing or nearly expired, or after a 401.
// There is no timer: an open but unused tab makes no requests, so it doesn't count as use and the
// server's idle limit still applies to a forgotten browser.

export interface Account {
  id: number;
  username: string;
}

const SessionResponse = z.object({
  access_token: z.string(),
  expires_at: z.string(),
  account: z.object({ id: z.number(), username: z.string() }),
});

const RENEW_MARGIN_MS = 60_000;
const LOCK_NAME = 'scrylux-session-refresh';

let accessToken: string | null = null;
let expiresAt = 0;
let inflight: Promise<Account> | null = null;
const endedListeners = new Set<() => void>();

export const getAccessToken = (): string | null => accessToken;

export function tokenNeedsRenewal(): boolean {
  return accessToken === null || expiresAt - Date.now() < RENEW_MARGIN_MS;
}

export function clearAccessToken(): void {
  accessToken = null;
  expiresAt = 0;
}

// Called when a session that was in use dies: the access token was refused and could not be renewed.
export function onSessionEnded(listener: () => void): () => void {
  endedListeners.add(listener);
  return () => {
    endedListeners.delete(listener);
  };
}

export function emitSessionEnded(): void {
  clearAccessToken();
  for (const listener of endedListeners) listener();
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
}

async function adopt(res: Response): Promise<Account> {
  const parsed = SessionResponse.parse(await res.json());
  accessToken = parsed.access_token;
  expiresAt = new Date(parsed.expires_at).getTime();
  return parsed.account;
}

export async function signIn(username: string, password: string): Promise<Account> {
  const res = await post('/api/session', { username, password });
  if (!res.ok) throw await toApiError(res);
  return adopt(res);
}

async function doRenew(): Promise<Account> {
  const res = await post('/api/session/refresh', {});
  if (!res.ok) {
    // Only a 401 means the session is gone. A server error leaves the current token alone.
    if (res.status === 401) clearAccessToken();
    throw await toApiError(res);
  }
  return adopt(res);
}

// Single-flight within the tab, and serialized across tabs with Web Locks, so a second tab's renewal
// sends the cookie that the first tab's renewal just rotated. Where Web Locks is missing, the server's
// grace window covers the race.
export function renew(): Promise<Account> {
  inflight ??= (async () => {
    try {
      return 'locks' in navigator ? await navigator.locks.request(LOCK_NAME, doRenew) : await doRenew();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

// Neither call throws for an HTTP error: the browser is signed out either way. A network failure
// rejects, after the token is forgotten, so the caller can say the server wasn't reached.
export async function logout(): Promise<void> {
  try {
    await post('/api/session/logout', {});
  } finally {
    clearAccessToken();
  }
}

export async function logoutAll(): Promise<void> {
  try {
    await post('/api/session/logout-all', {});
  } finally {
    clearAccessToken();
  }
}

