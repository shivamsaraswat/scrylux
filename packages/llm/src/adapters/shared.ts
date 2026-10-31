import { AdapterError } from '../errors.js';

// What the four adapters share: reading a retry-after, and sorting a provider's 400 into the layer's categories
// (research #8). A 400's text is read here only to choose a category. It is never kept, logged or returned.

/** A retry-after header as milliseconds: whole or fractional seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** One header from an SDK error's headers, which every SDK gives as a fetch `Headers`. */
export function headerValue(headers: unknown, name: string): string | undefined {
  const get = (headers as { get?: (header: string) => string | null } | null | undefined)?.get;
  return typeof get === 'function' ? (get.call(headers, name) ?? undefined) : undefined;
}

const INPUT_TOO_LARGE =
  /prompt is too long|too long|context[ _](window|length)|maximum context|too many tokens|token count|exceeds? the (maximum|limit)|request too large|input is too large/i;
const FORMAT =
  /output_config|output_format|response_format|json_schema|structured output|response_schema|responseJsonSchema|responseMimeType|outputConfig|textFormat/i;

export interface BadRequestHints {
  /** A machine code the provider gave, such as OpenAI's `context_length_exceeded`. */
  code?: string | null | undefined;
  /** The parameter the provider says is at fault. */
  param?: string | null | undefined;
}

/**
 * Sorts a 400 into: a setting the layer can drop and resend (temperature, the output format, the name of the output
 * limit), an input that is too large, or a request that was rejected for a reason the layer cannot work around.
 */
export function classifyBadRequest(text: string, hints: BadRequestHints = {}): AdapterError {
  if (hints.code === 'context_length_exceeded') return new AdapterError('input_too_large');
  if (hints.param === 'temperature') return new AdapterError('rejected', { rejectedParam: 'temperature' });
  if (hints.param === 'max_tokens' || hints.param === 'max_completion_tokens') {
    return new AdapterError('rejected', { rejectedParam: 'max_tokens' });
  }
  if (hints.param === 'response_format') return new AdapterError('rejected', { rejectedParam: 'format' });

  if (/temperature/i.test(text)) return new AdapterError('rejected', { rejectedParam: 'temperature' });
  if (/max_tokens|max_completion_tokens/i.test(text)) return new AdapterError('rejected', { rejectedParam: 'max_tokens' });
  if (FORMAT.test(text)) return new AdapterError('rejected', { rejectedParam: 'format' });
  if (INPUT_TOO_LARGE.test(text)) return new AdapterError('input_too_large');
  return new AdapterError('rejected');
}

/** The category for a status code that needs no reading of the body. Undefined for a 400, which needs classifying. */
export function categoryForStatus(status: number): 'not_authorized' | 'not_available' | 'input_too_large' | 'rate_limited' | 'provider_unavailable' | 'rejected' | undefined {
  if (status === 401 || status === 403) return 'not_authorized';
  if (status === 404) return 'not_available';
  if (status === 413) return 'input_too_large';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  if (status === 400) return undefined;
  return 'rejected';
}
