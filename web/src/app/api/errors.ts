import { HttpErrorResponse } from '@angular/common/http';
import { ApiErrorBody, ValidationErrorItem } from './models';

/** Turn a FastAPI validation item into "field: message". */
function describeValidation(item: ValidationErrorItem): string {
  const loc = (item.loc ?? []).filter((p) => p !== 'body' && p !== 'query' && p !== 'path');
  const field = loc.length ? String(loc[loc.length - 1]).replace(/_/g, ' ') : '';
  const msg = (item.msg ?? 'invalid value').replace(/^Value error, /, '');
  return field ? `${field}: ${msg}` : msg;
}

/** Extract a readable message from a FastAPI `{detail}` body (string or validation array). */
export function detailMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return typeof body === 'string' && body.trim() && !body.trim().startsWith('<') ? body.trim() : null;
  }
  const detail = (body as ApiErrorBody).detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) return detail.map(describeValidation).join('; ');
  return null;
}

function capitalise(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** A human-readable message for any error thrown by HttpClient, fetch, or app code. */
export function apiErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return 'Cannot reach the server. Check your connection and try again.';
    const fromBody = detailMessage(err.error);
    if (fromBody) return capitalise(fromBody);
    if (err.status === 401) return 'Your session has expired. Please sign in again.';
    if (err.status === 403) return 'You do not have permission to do that.';
    if (err.status === 404) return 'Not found.';
    if (err.status === 413) return 'The file is too large.';
    if (err.status === 429) return 'Too many requests; slow down and try again shortly.';
    if (err.status >= 500) return `The server had a problem (HTTP ${err.status}). Try again.`;
    return `${fallback} (HTTP ${err.status})`;
  }
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Error thrown by the fetch-based streaming client, carrying the HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
