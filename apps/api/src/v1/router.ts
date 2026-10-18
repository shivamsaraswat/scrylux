import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { HttpError, mapStorageError } from './errors.js';
import { allOperations } from './openapi.js';
import { DEFAULT_BODY_LIMIT, parseBody, parseId, parseQuery, type Method, type Operation, type TextResult } from './operation.js';
import { logWrite, type WriteAction } from './write-log.js';

export const v1Router = Router();

const MAX_ACCOUNT_ID = 2147483647;

// requireV1Token has already checked the token's signature and expiry (and, for a UI access token, that
// its session is still active). v1 additionally needs the account it names: a token without a usable
// numeric `sub` is rejected, never guessed at.
function requireAccount(req: Request, res: Response, next: NextFunction): void {
  const sub = typeof req.user === 'object' ? req.user.sub : undefined;
  const accountId = typeof sub === 'string' && /^\d+$/.test(sub) ? Number(sub) : 0;
  if (!Number.isSafeInteger(accountId) || accountId < 1 || accountId > MAX_ACCOUNT_ID) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  res.locals.accountId = accountId;
  next();
}

const WRITE_ACTIONS: Partial<Record<Method, WriteAction>> = { post: 'create', patch: 'update', delete: 'delete' };

function idOf(record: unknown): string | undefined {
  if (typeof record !== 'object' || record === null || !('id' in record)) return undefined;
  return typeof record.id === 'string' ? record.id : undefined;
}

// A document to download. `attachment` names the file, and nothing may keep a copy: it holds a whole threat model. The
// header is written out, with the name quoted, because the web app reads the name from `filename="..."` and Express 5.3
// stopped quoting a name that needs no quotes. The names come from `fileSlug` and hold only lower-case letters, digits,
// hyphens and dots, so there is nothing to escape.
function sendText(res: Response, result: TextResult): void {
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.type(result.contentType);
  res.setHeader('Cache-Control', 'no-store');
  if (result.csp !== undefined) res.setHeader('Content-Security-Policy', result.csp);
  res.status(200).send(result.body);
}

function handle(op: Operation<unknown>): RequestHandler {
  return async (req, res) => {
    try {
      const id = op.path.includes(':id') ? parseId(req.params.id) : '';
      // The id is checked first, then the query, then the body, then whether the record exists.
      const query = op.query ? parseQuery(op.query.schema, req.query) : undefined;
      const body = op.body ? parseBody(op.body.schema, req.body, op.method === 'patch') : undefined;
      const accountId = res.locals.accountId as number;

      const result = await op.handler({ id, body, query, accountId });

      if (op.text) {
        sendText(res, result as TextResult);
        return;
      }

      // The write has happened by now, so it is logged even if building the response fails.
      const action = WRITE_ACTIONS[op.method];
      if (action && op.recordType) logWrite(accountId, action, op.recordType, action === 'delete' ? id : (idOf(result) ?? id));

      if (op.status === 204) {
        res.status(204).end();
        return;
      }
      // Every success body is parsed with the shared record schema, so what is sent is what the
      // contract says and a stray column is a server bug, not a leak (FR-011, research #8).
      const payload = op.response ? (op.response.list ? op.response.schema.array() : op.response.schema).parse(result) : result;
      res.status(op.status).json(payload);
    } catch (err) {
      const mapped = err instanceof HttpError ? err : mapStorageError(err, op.method === 'delete' ? 'delete' : 'write');
      if (!mapped) throw err;
      res.status(mapped.status).json({ error: mapped.message });
    }
  };
}

const register: Record<Method, (path: string, ...handlers: RequestHandler[]) => unknown> = {
  get: (path, ...handlers) => v1Router.get(path, ...handlers),
  post: (path, ...handlers) => v1Router.post(path, ...handlers),
  patch: (path, ...handlers) => v1Router.patch(path, ...handlers),
  delete: (path, ...handlers) => v1Router.delete(path, ...handlers),
};

// A body is read here, per operation, after requireV1Token and requireAccount have run, and never earlier (research
// #2): the app's own parser skips /api/v1. A parse error or a body over the operation's limit reaches the app's error
// handler as it always did, so the 400 and 413 answers are unchanged.
v1Router.use(requireAccount);
for (const op of allOperations) {
  const readBody = op.body ? [express.json({ limit: op.bodyLimit ?? DEFAULT_BODY_LIMIT })] : [];
  register[op.method](op.path, ...readBody, handle(op));
}

// Express decodes a path parameter itself, before parseId runs, and throws a URIError (status 400)
// for one that cannot be percent-decoded, such as "%zz". Every v1 parameter is an id, so that is a
// malformed id (FR-007). The error's own message echoes the value, so it is never sent.
v1Router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof URIError) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  next(err);
});
