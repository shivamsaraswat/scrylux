import { formatValidationError, uuid } from '@scrylux/core';
import type { z } from 'zod';
import { HttpError } from './errors.js';
import type { RecordType } from './write-log.js';

// Every list operation states its order in the OpenAPI document (FR-003).
export const LIST_ORDER_DESCRIPTION = 'Oldest first by creation time; ties broken by id.';

export type Method = 'get' | 'post' | 'patch' | 'delete';

// The request body limit of every operation that does not set its own.
export const DEFAULT_BODY_LIMIT = 100 * 1024;

interface OperationContext<B, Q> {
  // The :id path parameter, already validated. Empty for a path that has none.
  id: string;
  // The request body, already parsed with the operation's schema.
  body: B;
  // The query string, already parsed with the operation's schema.
  query: Q;
  accountId: number;
}

// The policy a downloaded document is sent with, in place of the app's own. The app's policy is for the pages it
// serves; a download is not one, and the API only answers a request that carries a token, so a browser cannot be sent to
// it. If one ever were shown at this origin, this sandboxes it and allows nothing at all, whatever the document says.
export const DOWNLOAD_CSP = "sandbox; default-src 'none'";

// What a handler of a text operation returns: a document to download rather than a JSON record (the report).
export interface TextResult {
  body: string;
  // The full Content-Type, charset included.
  contentType: string;
  // The file name the document is saved under.
  filename: string;
  // Replaces the app's Content-Security-Policy on this response only.
  csp?: string;
}

// One API operation. The router mounts exactly these and the OpenAPI document describes exactly
// these, so the two cannot disagree (research #3).
export interface Operation<B = never, Q = unknown> {
  method: Method;
  // Express style, relative to the /api/v1 mount: '/projects/:id'.
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  // `name` is the schema's component name in the OpenAPI document.
  body?: { name: string; schema: z.ZodType<B> };
  // The most bytes the request body may hold. Defaults to DEFAULT_BODY_LIMIT. The body is read only after the request
  // is authenticated (research #2), so a raised limit costs the server nothing for anyone without an account.
  bodyLimit?: number;
  // The query string. The schema is a shared one from core and carries its own error message, which is the 400.
  query?: { name: string; schema: z.ZodType<Q> };
  response?: { name: string; schema: z.ZodType; list?: boolean };
  // Marks an operation whose handler returns a TextResult, sent as a download. Lists the media types it can answer
  // with, for the OpenAPI document, which has no JSON schema for them.
  text?: { mediaTypes: readonly string[] };
  status: 200 | 201 | 204;
  // Error statuses to document, besides 401 and 500 (every operation) and 400 and 413 (every body).
  errors: number[];
  // Set on every create, update and delete: it is what gets written to the write log.
  recordType?: RecordType;
  handler(ctx: OperationContext<B, Q>): Promise<unknown>;
}

// Lets a resource file declare an operation with its body and query types inferred, in an array of them.
export function defineOperation<B = never, Q = never>(operation: Operation<B, Q>): Operation<unknown> {
  return operation;
}

export function parseId(raw: unknown): string {
  const result = uuid.safeParse(raw);
  if (!result.success) throw new HttpError(400, 'Invalid id');
  return result.data;
}

export function parseQuery<Q>(schema: z.ZodType<Q>, raw: unknown): Q {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid query');
  return result.data;
}

// An update needs at least one field (FR-006).
export function parseBody<B>(schema: z.ZodType<B>, raw: unknown, update: boolean): B {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, formatValidationError(result.error));
  if (update && Object.keys(result.data as object).length === 0) {
    throw new HttpError(400, 'No updatable fields provided');
  }
  return result.data;
}
