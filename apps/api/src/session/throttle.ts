import { createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { verifyCredentials, type User } from '../auth.js';
import config from '../config.js';
import db from '../db.js';
import { logSessionEvent } from './log.js';

// Sign-in throttling (spec FR-005g, research #10, data-model.md 012). Both POST /api/login and
// POST /api/session go through signInGate(), so they share one set of limits. Failures are counted per
// username-and-address pair and per address. There is deliberately no per-account lockout: an attacker
// could use it to lock the admin out, so only the guessing address is slowed down.

const THROTTLED = 'Too many sign-in attempts. Try again later.';

// A purpose-specific subkey, so the JWT signing secret is never used raw for a second purpose.
function throttleKey(): Buffer {
  return createHmac('sha256', String(config.jwtSecret)).update('scrylux/sign-in-throttle/v1').digest();
}

function hmac(data: string): string {
  return createHmac('sha256', throttleKey()).update(data).digest('hex');
}

// The stored keys are HMACs, so the table holds no username (which can be a password typed into the
// wrong field) and no client address in plaintext.
export const pairKey = (username: string, address: string): string => `pair:${hmac(`${username}\n${address}`)}`;
export const addrKey = (address: string): string => `addr:${hmac(address)}`;

// Expands an IPv6 address to its eight 16-bit groups, or returns null when it isn't a valid one. An
// embedded IPv4 tail (::ffff:1.2.3.4) counts for two groups.
function ipv6Groups(address: string): number[] | null {
  let text = address.split('%')[0] ?? '';
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)?.[1];
  if (tail) {
    const octets = tail.split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(Math.max(missing, 0)).fill('0'), ...right];
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16));
}

// The address that sign-in failures are counted against. One host controls a whole IPv6 /64, so every
// address inside it counts as one: otherwise a single machine could rotate source addresses and get a
// fresh set of guesses for each. An IPv4-mapped address counts as its IPv4 address. IPv4 is unchanged.
export function normalizeAddress(ip: string): string {
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) return ip.slice('::ffff:'.length);
  if (!ip.includes(':')) return ip;
  const groups = ipv6Groups(ip);
  if (!groups) return ip;
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

// With TRUST_PROXY unset this is the socket address, and a client-sent X-Forwarded-For is ignored.
function clientAddress(req: Request): string {
  return normalizeAddress(req.ip ?? 'unknown');
}

// The seconds left on the longest block among these keys, or 0.
async function blockedFor(keys: string[]): Promise<number> {
  const { rows } = await db.query<{ seconds: number | null }>(
    `SELECT ceil(extract(epoch FROM (max(blocked_until) - now())))::int AS seconds
       FROM sign_in_throttle WHERE key = ANY($1::text[]) AND blocked_until > now()`,
    [keys],
  );
  return rows[0]?.seconds ?? 0;
}

// One atomic upsert per key: no read-modify-write, so concurrent failures, even on different app
// instances, are all counted. A failure after the counting window restarts the count at 1. Reaching
// the threshold sets blocked_until to base * 2^(failures - threshold), capped at the maximum wait, and
// forget_after to the moment the row stops mattering. The exponent is capped so power() cannot overflow.
async function recordFailure(key: string, threshold: number): Promise<void> {
  await db.query(
    `INSERT INTO sign_in_throttle AS t (key, failures, window_started_at, blocked_until, forget_after)
     VALUES (
       $1, 1, now(),
       CASE WHEN 1 >= $2::int
            THEN now() + LEAST($3::double precision * power(2, LEAST(1 - $2::int, 30)), $4::double precision) * interval '1 millisecond'
       END,
       now() + $4::double precision * interval '1 millisecond'
     )
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN t.window_started_at < now() - $4::double precision * interval '1 millisecond'
                       THEN 1 ELSE t.failures + 1 END,
       window_started_at = CASE WHEN t.window_started_at < now() - $4::double precision * interval '1 millisecond'
                                THEN now() ELSE t.window_started_at END,
       blocked_until = CASE
         WHEN (CASE WHEN t.window_started_at < now() - $4::double precision * interval '1 millisecond'
                    THEN 1 ELSE t.failures + 1 END) >= $2::int
         THEN now() + LEAST($3::double precision * power(2, LEAST((CASE WHEN t.window_started_at < now() - $4::double precision * interval '1 millisecond'
                                                                         THEN 1 ELSE t.failures + 1 END) - $2::int, 30)),
                            $4::double precision) * interval '1 millisecond'
       END,
       forget_after = GREATEST(
         (CASE WHEN t.window_started_at < now() - $4::double precision * interval '1 millisecond'
               THEN now() ELSE t.window_started_at END) + $4::double precision * interval '1 millisecond',
         CASE
           WHEN (CASE WHEN t.window_started_at < now() - $4::double precision * interval '1 millisecond'
                      THEN 1 ELSE t.failures + 1 END) >= $2::int
           THEN now() + LEAST($3::double precision * power(2, LEAST((CASE WHEN t.window_started_at < now() - $4::double precision * interval '1 millisecond'
                                                                           THEN 1 ELSE t.failures + 1 END) - $2::int, 30)),
                              $4::double precision) * interval '1 millisecond'
           ELSE now()
         END
       )`,
    [key, threshold, config.signInBaseWaitMs, config.signInMaxWaitMs],
  );
}

async function accountIdOf(username: string): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM users WHERE username = $1', [username]);
  return rows[0]?.id ?? null;
}

// The shared first half of both sign-in routes (contracts/session-api.md, "Sign-in throttling"). It
// either answers the request itself, and returns null, or returns the verified user, and the route
// carries on. Failure and refusal answers, and their log lines, behave the same whether or not the
// username exists, so nothing here reveals which accounts exist.
export async function signInGate(req: Request, res: Response): Promise<User | null> {
  const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return null;
  }

  const address = clientAddress(req);
  const pair = pairKey(username, address);
  const addr = addrKey(address);

  const wait = await blockedFor([pair, addr]);
  if (wait > 0) {
    logSessionEvent('sign_in_throttled', { accountId: await accountIdOf(username), sessionId: null });
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: THROTTLED });
    return null;
  }

  const user = await verifyCredentials(username, password);
  if (!user) {
    await recordFailure(pair, config.signInFailuresPerAccount);
    await recordFailure(addr, config.signInFailuresPerAddress);
    await db.query('DELETE FROM sign_in_throttle WHERE forget_after < now()');
    logSessionEvent('sign_in_failed', { accountId: await accountIdOf(username), sessionId: null });
    res.status(401).json({ error: 'Invalid credentials' });
    return null;
  }

  // A success clears this username from this address. The address count is left to age out, so one
  // success doesn't reset an address that is guessing at many accounts.
  await db.query('DELETE FROM sign_in_throttle WHERE key = $1', [pair]);
  return user;
}
