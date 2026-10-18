import { formatValidationError } from '@scrylux/core';
import { z } from 'zod';
import { HttpError } from '../../v1/errors.js';

// Parses part of a request's file with a core schema, and, if it is refused, says so with the place in the file: each
// issue is moved under `path`, so a message reads `file.components.2.attributes.scrylux: …`. It repeats no value of the
// file, as `formatValidationError` never does.
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown, path: readonly (string | number)[] = ['file']): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ ...issue, path: [...path, ...issue.path] }));
  throw new HttpError(400, formatValidationError(new z.ZodError(issues)));
}

export const refuse = (message: string): HttpError => new HttpError(400, message);
