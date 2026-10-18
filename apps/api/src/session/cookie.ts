import type { NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'scrylux_session';
const COOKIE_PATH = '/api/session';
const MAX_CREDENTIAL_LENGTH = 128;

// Reads only the session cookie from the Cookie header. No cookie parser is needed for one cookie.
export function readSessionCookie(req: Request): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === COOKIE_NAME) {
      const value = part.slice(at + 1).trim();
      // A real credential is 43 characters. Anything much longer is not one.
      return value.length <= MAX_CREDENTIAL_LENGTH ? value : undefined;
    }
  }
  return undefined;
}

// The page's real scheme is what the browser reports in Origin, so a request is treated as HTTPS when
// Express says so (behind a trusted proxy) or when its Origin is https. That keeps Secure on behind a
// TLS-terminating load balancer even if TRUST_PROXY is forgotten, and leaves it off for the plain-HTTP
// localhost quickstart, where Safari doesn't reliably store Secure cookies.
function isSecure(req: Request): boolean {
  return req.secure || (req.get('origin') ?? '').startsWith('https://');
}

function baseOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    path: COOKIE_PATH,
    secure: isSecure(req),
  };
}

// Never a Domain attribute, so the cookie is host-only. The cookie reaches only the session
// endpoints, never the API or a page.
export function setSessionCookie(req: Request, res: Response, value: string, expiresAt: Date): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  res.cookie(COOKIE_NAME, value, { ...baseOptions(req), maxAge });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.cookie(COOKIE_NAME, '', { ...baseOptions(req), maxAge: 0 });
}

// The CSRF defense for the session endpoints, layered on SameSite=Strict: the Origin header's host
// must equal the request's host, and the body must be JSON, which forces a CORS preflight that the
// app never answers for a cross-site fetch. The v1 API is not cookie-authenticated, so it needs
// neither. Neither check touches the database.
//
// The request's host is Express's `req.host`: the Host header, or, only when TRUST_PROXY says the peer
// is a trusted proxy, X-Forwarded-Host. A reverse proxy that rewrites Host (nginx without
// `proxy_set_header Host $host`) would otherwise make every sign-in a 403. A cross-site page can't add
// that header to a request without a CORS preflight, which the app never answers.
export function requireSameOriginJson(req: Request, res: Response, next: NextFunction): void {
  const origin = req.get('origin');
  let originHost: string | undefined;
  try {
    originHost = origin ? new URL(origin).host : undefined;
  } catch {
    originHost = undefined;
  }
  if (!originHost || originHost !== req.host) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (!req.is('application/json')) {
    res.status(415).json({ error: 'Unsupported Media Type' });
    return;
  }
  next();
}
