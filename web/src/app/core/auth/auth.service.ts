import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, catchError, finalize, firstValueFrom, from, map, of, shareReplay, switchMap, tap } from 'rxjs';

import { API, SILENT, SKIP_AUTH_RETRY } from '../../api/http-context';
import {
  AcceptInviteIn,
  BootstrapOut,
  InvitePreviewOut,
  LoginIn,
  MeOut,
  PasswordChangeIn,
  RegisterIn,
  TokenOut,
} from '../../api/models';

const AUTH = `${API}/auth`;
/** Refresh this many seconds before the access token expires. */
const REFRESH_LEAD_S = 60;
const MIN_REFRESH_DELAY_S = 10;
const RETRY_AFTER_NETWORK_ERROR_S = 30;

/** Requests made to auth endpoints never trigger the interceptor's refresh-and-retry. */
function authContext(silentRequest = false): HttpContext {
  const ctx = new HttpContext().set(SKIP_AUTH_RETRY, true);
  return silentRequest ? ctx.set(SILENT, true) : ctx;
}

interface LockManagerLike {
  request<T>(name: string, cb: () => Promise<T>): Promise<T>;
}

/**
 * Session state. The access token lives only in memory; the refresh token is an httpOnly
 * cookie scoped to `/api/auth` that the browser sends on `POST /api/auth/refresh`.
 */
@Injectable({ providedIn: 'root' })
export class AuthService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly _token = signal<string | null>(null);
  private readonly _me = signal<MeOut | null>(null);
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Observable<string | null> | null = null;

  readonly me = this._me.asReadonly();
  readonly user = computed(() => this._me()?.user ?? null);
  readonly memberships = computed(() => this._me()?.memberships ?? []);
  readonly isAuthenticated = computed(() => this._token() !== null);

  accessToken(): string | null {
    return this._token();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  // ---------------------------------------------------------------- public endpoints

  bootstrap(): Observable<BootstrapOut> {
    return this.http.get<BootstrapOut>(`${AUTH}/bootstrap`, { context: authContext() });
  }

  invitePreview(token: string): Observable<InvitePreviewOut> {
    return this.http.get<InvitePreviewOut>(`${AUTH}/invite/${encodeURIComponent(token)}`, {
      context: authContext(),
    });
  }

  login(body: LoginIn): Observable<MeOut> {
    return this.http
      .post<TokenOut>(`${AUTH}/login`, body, { withCredentials: true, context: authContext() })
      .pipe(
        tap((t) => this.setToken(t)),
        switchMap(() => this.loadMe()),
      );
  }

  register(body: RegisterIn): Observable<MeOut> {
    return this.http
      .post<TokenOut>(`${AUTH}/register`, body, { withCredentials: true, context: authContext() })
      .pipe(
        tap((t) => this.setToken(t)),
        switchMap(() => this.loadMe()),
      );
  }

  // ---------------------------------------------------------------- session

  /** Called once at startup: silently restore a session from the refresh cookie. */
  async restoreSession(): Promise<void> {
    const token = await firstValueFrom(this.refresh());
    if (!token) return;
    try {
      await firstValueFrom(this.loadMe());
    } catch {
      this.clearSession();
    }
  }

  loadMe(): Observable<MeOut> {
    return this.http.get<MeOut>(`${AUTH}/me`).pipe(tap((me) => this._me.set(me)));
  }

  /**
   * Single-flight refresh: concurrent callers share one request. Emits the new access token,
   * or `null` if the session could not be refreshed. Never errors.
   */
  refresh(): Observable<string | null> {
    if (!this.inflight) {
      this.inflight = from(this.withRefreshLock(() => firstValueFrom(this.refreshRequest()))).pipe(
        finalize(() => (this.inflight = null)),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    }
    return this.inflight;
  }

  private refreshRequest(): Observable<string | null> {
    return this.http
      .post<TokenOut>(`${AUTH}/refresh`, null, {
        withCredentials: true,
        headers: { 'X-Ragdag': '1' },
        context: authContext(true),
      })
      .pipe(
        tap((t) => this.setToken(t)),
        map((t) => t.access_token),
        catchError((err: unknown) => {
          const status = err instanceof HttpErrorResponse ? err.status : 0;
          if (status === 400 || status === 401 || status === 403) this.clearSession();
          return of(null);
        }),
      );
  }

  /** Serialise refreshes across tabs: the refresh token rotates and reuse revokes the session. */
  private withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
    return locks ? locks.request('ragdag-auth-refresh', fn) : fn();
  }

  /** The refresh failed: drop local state and go to the login page, remembering where we were. */
  sessionExpired(): void {
    const wasAuthenticated = this.isAuthenticated() || this._me() !== null;
    this.clearSession();
    const current = this.router.url;
    if (current.startsWith('/login') || current.startsWith('/invite')) return;
    void this.router.navigate(['/login'], {
      queryParams: { next: current && current !== '/' ? current : null, expired: wasAuthenticated ? 1 : null },
    });
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post<void>(`${AUTH}/logout`, null, { withCredentials: true, context: authContext() }),
      );
    } catch {
      // The local session ends regardless.
    }
    this.clearSession();
    await this.router.navigate(['/login']);
  }

  changePassword(body: PasswordChangeIn): Observable<void> {
    return this.http.post<void>(`${AUTH}/password`, body);
  }

  acceptInvite(body: AcceptInviteIn): Observable<MeOut> {
    return this.http.post<MeOut>(`${AUTH}/accept-invite`, body).pipe(tap((me) => this._me.set(me)));
  }

  /** Update cached memberships after workspace changes (create / rename / leave). */
  reloadMe(): Promise<MeOut> {
    return firstValueFrom(this.loadMe());
  }

  clearSession(): void {
    this.clearTimer();
    this._token.set(null);
    this._me.set(null);
  }

  // ---------------------------------------------------------------- token bookkeeping

  private setToken(t: TokenOut): void {
    this._token.set(t.access_token);
    this.scheduleRefresh(t.expires_in);
  }

  private scheduleRefresh(expiresIn: number): void {
    this.clearTimer();
    const delayS = Math.max(MIN_REFRESH_DELAY_S, expiresIn - REFRESH_LEAD_S);
    this.refreshTimer = setTimeout(() => this.timedRefresh(), Math.min(delayS * 1000, 2_147_000_000));
  }

  private timedRefresh(): void {
    this.refreshTimer = null;
    this.refresh().subscribe((token) => {
      if (token) return;
      if (this._token() !== null) {
        // Network or server trouble, not a rejected session: keep going and try again soon.
        this.refreshTimer = setTimeout(() => this.timedRefresh(), RETRY_AFTER_NETWORK_ERROR_S * 1000);
      } else {
        this.sessionExpired();
      }
    });
  }

  private clearTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
