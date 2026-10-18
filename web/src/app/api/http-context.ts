import { HttpContext, HttpContextToken } from '@angular/common/http';

/** Background requests (polling) that should not drive the global progress bar. */
export const SILENT = new HttpContextToken<boolean>(() => false);

/** Requests that must not trigger a refresh-and-retry on 401 (the auth endpoints themselves). */
export const SKIP_AUTH_RETRY = new HttpContextToken<boolean>(() => false);

export function silent(): HttpContext {
  return new HttpContext().set(SILENT, true);
}

export const API = '/api';

/** Build HttpParams-compatible object, dropping empty values. */
export function params(
  obj: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return out;
}
