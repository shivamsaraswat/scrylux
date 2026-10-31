// Configuration comes from environment variables. If DB_SECRET_ID is set, `load()` also
// pulls credentials from AWS Secrets Manager (via the instance/task role) and overrides
// the matching env values. Call `await config.load()` once at startup, before using ./db.

export interface DbConfig {
  host?: string;
  port: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface SecretClient {
  send(command: unknown): Promise<{ SecretString?: string }>;
}

export interface LoadOptions {
  secretId?: string;
  client?: SecretClient;
}

interface SecretPayload {
  host?: string;
  port?: string | number;
  dbname?: string;
  username?: string;
  password?: string;
  JWT_SECRET?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  LLM_API_KEY?: string;
  EMBEDDING_API_KEY?: string;
}

// Browser sessions, sign-in throttling and the proxy setting (Phase 1 Milestone 6). Durations are in
// milliseconds. trustProxy is Express's `trust proxy` value: false trusts no proxy.
interface SessionConfig {
  sessionMaxLifetimeMs: number;
  sessionIdleTimeoutMs: number;
  signInFailuresPerAccount: number;
  signInFailuresPerAddress: number;
  signInBaseWaitMs: number;
  signInMaxWaitMs: number;
  trustProxy: false | number | string;
}

export interface Config extends SessionConfig {
  port: number;
  db: DbConfig;
  jwtSecret?: string;
  jwtExpiresIn: string;
  adminUsername?: string;
  adminPassword?: string;
  // AI provider keys (Phase 3 Milestone 1): never logged, stored or sent to the browser. Everything else the AI layer
  // reads comes from the environment, through parseLlmConfig in @scrylux/llm.
  llmApiKey?: string;
  embeddingApiKey?: string;
  load: (opts?: LoadOptions) => Promise<Config>;
}

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

// An unset or empty variable takes its default. Anything else must be exactly `<int><s|m|h|d>`, and
// positive. The error names the variable and never echoes its value.
function parseDuration(name: string, raw: string | undefined, fallbackMs: number): number {
  if (raw === undefined || raw === '') return fallbackMs;
  const match = /^(\d+)([smhd])$/.exec(raw);
  const ms = match ? Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS] : 0;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`${name} must be a whole number followed by s, m, h or d (seconds, minutes, hours, days), and not zero`);
  return ms;
}

function parseCount(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : 0;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1`);
  return n;
}

// A hop count (`1` behind one load balancer), or a comma-separated list of addresses, CIDR ranges and
// Express's named ranges. `true` is refused: it trusts any client-sent X-Forwarded-For, which lets a
// client choose the address that sign-in throttling counts.
const PROXY_TOKEN = /^(loopback|linklocal|uniquelocal|[0-9a-fA-F:.]+(\/\d{1,3})?)$/;
function parseTrustProxy(raw: string | undefined): false | number | string {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'true' || !raw.split(',').every((token) => PROXY_TOKEN.test(token.trim()))) {
    throw new Error('TRUST_PROXY must be a hop count or a comma-separated list of addresses, and may not be "true"');
  }
  return raw;
}

export function parseSessionConfig(env: NodeJS.ProcessEnv): SessionConfig {
  const sessionMaxLifetimeMs = parseDuration('SESSION_MAX_LIFETIME', env.SESSION_MAX_LIFETIME, 30 * UNIT_MS.d);
  const sessionIdleTimeoutMs = parseDuration('SESSION_IDLE_TIMEOUT', env.SESSION_IDLE_TIMEOUT, 7 * UNIT_MS.d);
  if (sessionIdleTimeoutMs > sessionMaxLifetimeMs) {
    throw new Error('SESSION_IDLE_TIMEOUT must not be longer than SESSION_MAX_LIFETIME');
  }
  const signInBaseWaitMs = parseDuration('SIGN_IN_BASE_WAIT', env.SIGN_IN_BASE_WAIT, 30 * UNIT_MS.s);
  const signInMaxWaitMs = parseDuration('SIGN_IN_MAX_WAIT', env.SIGN_IN_MAX_WAIT, 15 * UNIT_MS.m);
  if (signInMaxWaitMs < signInBaseWaitMs) throw new Error('SIGN_IN_MAX_WAIT must not be shorter than SIGN_IN_BASE_WAIT');
  return {
    sessionMaxLifetimeMs,
    sessionIdleTimeoutMs,
    signInFailuresPerAccount: parseCount('SIGN_IN_FAILURES_PER_ACCOUNT', env.SIGN_IN_FAILURES_PER_ACCOUNT, 5),
    signInFailuresPerAddress: parseCount('SIGN_IN_FAILURES_PER_ADDRESS', env.SIGN_IN_FAILURES_PER_ADDRESS, 50),
    signInBaseWaitMs,
    signInMaxWaitMs,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

// Importing this module never throws: a bad value falls back to the defaults here, and server.ts
// validates the environment again at startup and refuses to start.
function sessionConfigFromEnv(): SessionConfig {
  try {
    return parseSessionConfig(process.env);
  } catch {
    return parseSessionConfig({});
  }
}

const config: Config = {
  port: Number(process.env.PORT) || 3000,
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  llmApiKey: process.env.LLM_API_KEY,
  embeddingApiKey: process.env.EMBEDDING_API_KEY,
  ...sessionConfigFromEnv(),
  load,
};

// Secret keys: host, port, dbname, username, password, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, LLM_API_KEY,
// EMBEDDING_API_KEY
async function fetchSecret(secretId: string, client?: SecretClient): Promise<SecretPayload> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const resolvedClient = client ?? new SecretsManagerClient({});
  const res = await resolvedClient.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!res.SecretString) throw new Error(`Secret ${secretId} has no SecretString`);
  return JSON.parse(res.SecretString) as SecretPayload;
}

async function load(opts: LoadOptions = {}): Promise<Config> {
  const { secretId = process.env.DB_SECRET_ID, client } = opts;
  if (!secretId) return config;
  let s: SecretPayload;
  try {
    s = await fetchSecret(secretId, client);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not load secret "${secretId}": ${message}`, { cause: err });
  }
  if (s.host) config.db.host = s.host;
  if (s.port) config.db.port = Number(s.port);
  if (s.dbname) config.db.database = s.dbname;
  if (s.username) config.db.user = s.username;
  if (s.password) config.db.password = s.password;
  if (s.JWT_SECRET) config.jwtSecret = s.JWT_SECRET;
  if (s.ADMIN_USERNAME) config.adminUsername = s.ADMIN_USERNAME;
  if (s.ADMIN_PASSWORD) config.adminPassword = s.ADMIN_PASSWORD;
  if (s.LLM_API_KEY) config.llmApiKey = s.LLM_API_KEY;
  if (s.EMBEDDING_API_KEY) config.embeddingApiKey = s.EMBEDDING_API_KEY;
  return config;
}

export default config;
