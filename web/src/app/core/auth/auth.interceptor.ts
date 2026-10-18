import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';

import { API, SKIP_AUTH_RETRY } from '../../api/http-context';
import { AuthService } from './auth.service';

function withBearer<T>(req: HttpRequest<T>, token: string): HttpRequest<T> {
  return req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
}

/**
 * Attaches the in-memory access token to API calls. On a 401 it refreshes once (shared by
 * every concurrent caller) and retries the request a single time; if the refresh fails the
 * user is sent to the login page.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(API + '/')) return next(req);

  const auth = inject(AuthService);
  const sentToken = auth.accessToken();
  const outgoing = sentToken ? withBearer(req, sentToken) : req;

  if (req.context.get(SKIP_AUTH_RETRY)) return next(outgoing);

  return next(outgoing).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || err.status !== 401) return throwError(() => err);

      // Another request already refreshed while this one was in flight: just retry.
      const current = auth.accessToken();
      if (current && current !== sentToken) return next(withBearer(req, current));

      return auth.refresh().pipe(
        switchMap((token) => {
          if (!token) {
            auth.sessionExpired();
            return throwError(() => err);
          }
          return next(withBearer(req, token));
        }),
      );
    }),
  );
};
