import bcrypt from 'bcryptjs';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { uuid } from '@scrylux/core';
import type { NextFunction, Request, Response } from 'express';
import config from './config.js';
import db from './db.js';
import { logSessionEvent } from './session/log.js';
import { endAllForUser, isActive } from './session/store.js';

declare global {
  // Augmenting Express's own ambient types requires its `Express` namespace — there is no
  // ES module alternative for this kind of global type augmentation.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: string | JwtPayload;
    }
  }
}

export interface User {
  id: number;
  username: string;
  password_hash: string;
}

// Compared against when the username doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export async function verifyCredentials(username: string, password: string): Promise<User | null> {
  const { rows } = await db.query<User>(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [username],
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  return ok && user ? user : null;
}

export function signToken(user: Pick<User, 'id' | 'username'>): string {
  const options: jwt.SignOptions = { expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'] };
  return jwt.sign({ sub: String(user.id), username: user.username }, config.jwtSecret as string, options);
}

// The audience that marks a browser UI's access token. An /api/login token has no audience.
const UI_AUDIENCE = 'scrylux-ui';
const ACCESS_TOKEN_SECONDS = 300;

// The short-lived token the browser UI keeps in page memory (research #6). It names its session, so
// it stops working as soon as that session ends, not when it expires.
export function signAccessToken(userId: number, sessionId: string): { token: string; expiresAt: Date } {
  const token = jwt.sign({ sub: String(userId), sid: sessionId }, config.jwtSecret as string, {
    audience: UI_AUDIENCE,
    expiresIn: ACCESS_TOKEN_SECONDS,
    algorithm: 'HS256',
  });
  const { exp } = jwt.decode(token) as { exp: number };
  return { token, expiresAt: new Date(exp * 1000) };
}

// Creates or updates one account from a configured password. It runs on every start, so it compares
// first: bcrypt hashes with a fresh salt each time, and re-writing an unchanged password would end
// every browser session on every restart or new instance (spec FR-005c). A real change updates the
// hash and ends the account's sessions in one transaction.
export async function seedUser(username: string, password: string): Promise<void> {
  const { rows } = await db.query<{ id: number; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE username = $1',
    [username],
  );
  const existing = rows[0];
  if (!existing) {
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING', [
      username,
      hash,
    ]);
    return;
  }
  if (await bcrypt.compare(password, existing.password_hash)) return;

  const hash = await bcrypt.hash(password, 10);
  const client = await db.connect();
  let ended: string[];
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, existing.id]);
    ended = await endAllForUser(existing.id, 'password_changed', client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  for (const sessionId of ended) {
    logSessionEvent('ended', { accountId: existing.id, sessionId, reason: 'password_changed' });
  }
}

// Creates the single admin user from env vars; re-running with a new password updates it.
export async function seedAdminUser(): Promise<void> {
  const { adminUsername, adminPassword } = config;
  if (!adminUsername || !adminPassword) {
    console.warn('ADMIN_USERNAME / ADMIN_PASSWORD not set; skipping user seed');
    return;
  }
  await seedUser(adminUsername, adminPassword);
  console.log('Seeded admin user');
}

// Reads and verifies the bearer token, answering 401 itself when it can't. The algorithm is pinned, so
// a token signed with another one is never accepted.
function verifyBearer(req: Request, res: Response): JwtPayload | null {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret as string, { algorithms: ['HS256'] });
    if (typeof payload === 'string') throw new Error('unexpected token payload');
    return payload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
}

function rejectToken(res: Response): void {
  res.status(401).json({ error: 'Invalid or expired token' });
}

// For /api/users: only an /api/login token, never the UI's access token. The UI never calls it, and a
// script injected into the page must not be able to create an account it can use later (Principle V).
export function requireApiToken(req: Request, res: Response, next: NextFunction): void {
  const payload = verifyBearer(req, res);
  if (!payload) return;
  if (payload.aud !== undefined) {
    rejectToken(res);
    return;
  }
  req.user = payload;
  next();
}

// For /api/v1: an /api/login token, as before, or a UI access token whose session is still active.
export async function requireV1Token(req: Request, res: Response, next: NextFunction): Promise<void> {
  const payload = verifyBearer(req, res);
  if (!payload) return;
  if (payload.aud !== undefined) {
    const sid: unknown = payload.sid;
    // A malformed sid gets the same 401 without a query, so it can't become a database error.
    const active =
      payload.aud === UI_AUDIENCE && typeof sid === 'string' && uuid.safeParse(sid).success && (await isActive(sid));
    if (!active) {
      rejectToken(res);
      return;
    }
  }
  req.user = payload;
  next();
}
