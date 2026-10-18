import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors.js';
import { clearAccessToken, getAccessToken, logout, logoutAll, onSessionEnded, renew, signIn } from './session.js';

// The browser session client (research #5, #15). The access token lives only in a module variable, is
// renewed through the HttpOnly cookie only when something needs it, and never touches browser storage.
const fetchMock = vi.fn<typeof fetch>();

// The URL of a recorded fetch call.
const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sessionBody(token = 'tok-1', secondsAhead = 300) {
  return {
    access_token: token,
    expires_at: new Date(Date.now() + secondsAhead * 1000).toISOString(),
    account: { id: 7, username: 'ada' },
  };
}

const calls = (): [string, RequestInit | undefined][] => fetchMock.mock.calls.map(([url, init]) => [urlOf(url), init]);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  clearAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('signIn()', () => {
  it('posts the credentials as JSON with same-origin credentials, and keeps the token in memory', async () => {
    fetchMock.mockResolvedValueOnce(json(200, sessionBody('tok-1')));

    const account = await signIn('ada', 'correct horse');

    expect(account).toEqual({ id: 7, username: 'ada' });
    const [url, init] = calls()[0] ?? ['', undefined];
    expect(url).toBe('/api/session');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ username: 'ada', password: 'correct horse' });
    expect(getAccessToken()).toBe('tok-1');
  });

  it('rejects with the server’s message and keeps no token on a 401 or 429', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Invalid credentials' }));
    await expect(signIn('ada', 'nope')).rejects.toMatchObject({ status: 401, message: 'Invalid credentials' });
    fetchMock.mockResolvedValueOnce(json(429, { error: 'Too many sign-in attempts. Try again later.' }));
    await expect(signIn('ada', 'nope')).rejects.toMatchObject({ status: 429 });
    expect(getAccessToken()).toBeNull();
  });
});

describe('renew()', () => {
  it('posts to /api/session/refresh with the cookie and stores the new token', async () => {
    fetchMock.mockResolvedValueOnce(json(200, sessionBody('tok-2')));

    await renew();

    const [url, init] = calls()[0] ?? ['', undefined];
    expect(url).toBe('/api/session/refresh');
    expect(init?.credentials).toBe('same-origin');
    expect(getAccessToken()).toBe('tok-2');
  });

  it('is single-flight: concurrent callers share one request', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, sessionBody('tok-3'))));

    await Promise.all([renew(), renew(), renew()]);

    expect(calls().filter(([url]) => url === '/api/session/refresh')).toHaveLength(1);
  });

  it('runs inside the cross-tab lock when the Web Locks API exists', async () => {
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback());
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    fetchMock.mockResolvedValueOnce(json(200, sessionBody()));
    try {
      await renew();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0]).toBe('scrylux-session-refresh');
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  it('works without the Web Locks API', async () => {
    expect('locks' in navigator).toBe(false);
    fetchMock.mockResolvedValueOnce(json(200, sessionBody()));
    await expect(renew()).resolves.toEqual({ id: 7, username: 'ada' });
  });

  it('rejects with ApiError 401 when the session is gone', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Session ended' }));
    await expect(renew()).rejects.toBeInstanceOf(ApiError);
    expect(getAccessToken()).toBeNull();
  });
});

describe('logout() and logoutAll()', () => {
  it('post to their endpoints and forget the token, even when the server answers an error', async () => {
    fetchMock.mockResolvedValueOnce(json(200, sessionBody()));
    await signIn('ada', 'pw');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await logout();
    expect(calls()[1]?.[0]).toBe('/api/session/logout');
    expect(getAccessToken()).toBeNull();

    fetchMock.mockResolvedValueOnce(json(200, sessionBody()));
    await signIn('ada', 'pw');
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Session ended' }));
    await logoutAll();
    expect(calls()[3]?.[0]).toBe('/api/session/logout-all');
    expect(getAccessToken()).toBeNull();
  });
});

describe('no background activity', () => {
  it('makes no request while idle, however long the clock runs', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(json(200, sessionBody()));
    await signIn('ada', 'pw');
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('browser storage', () => {
  it('is never written: the token lives in memory only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    fetchMock.mockResolvedValueOnce(json(200, sessionBody('secret-token')));
    await signIn('ada', 'pw');
    fetchMock.mockResolvedValueOnce(json(200, sessionBody('secret-token-2')));
    await renew();

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    setItem.mockRestore();
  });
});

describe('onSessionEnded()', () => {
  it('returns an unsubscribe function', () => {
    const listener = vi.fn();
    const off = onSessionEnded(listener);
    off();
    expect(listener).not.toHaveBeenCalled();
  });
});
