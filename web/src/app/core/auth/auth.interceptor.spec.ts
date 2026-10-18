import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';

const REFRESH = '/api/auth/refresh';
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('authInterceptor', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;
  let auth: AuthService;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    auth.clearSession();
    ctrl.verify();
  });

  /** Put a token in memory the way the app does: through a refresh. */
  async function signIn(token: string): Promise<void> {
    const p = firstValueFrom(auth.refresh());
    ctrl.expectOne(REFRESH).flush({ access_token: token, expires_in: 900 });
    expect(await p).toBe(token);
  }

  function unauthorized(url: string): void {
    ctrl.expectOne(url).flush({ detail: 'not authenticated' }, { status: 401, statusText: 'Unauthorized' });
  }

  it('attaches the bearer token to API requests only', async () => {
    await signIn('T1');
    http.get('/api/w/1/collections').subscribe();
    http.get('/assets/x.json').subscribe();
    expect(ctrl.expectOne('/api/w/1/collections').request.headers.get('Authorization')).toBe('Bearer T1');
    expect(ctrl.expectOne('/assets/x.json').request.headers.has('Authorization')).toBe(false);
  });

  it('sends the refresh request with credentials and the X-Ragdag header', () => {
    auth.refresh().subscribe();
    const req = ctrl.expectOne(REFRESH);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.headers.get('X-Ragdag')).toBe('1');
    req.flush({ access_token: 'T', expires_in: 900 });
  });

  it('on 401 refreshes once and retries the request with the new token', async () => {
    await signIn('OLD');
    const result = firstValueFrom(http.get<{ ok: boolean }>('/api/auth/me'));
    unauthorized('/api/auth/me');

    ctrl.expectOne(REFRESH).flush({ access_token: 'NEW', expires_in: 900 });
    await settle();

    const retry = ctrl.expectOne('/api/auth/me');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer NEW');
    retry.flush({ ok: true });
    expect(await result).toEqual({ ok: true });
    expect(auth.accessToken()).toBe('NEW');
  });

  it('shares a single refresh between concurrent 401s (single flight)', async () => {
    await signIn('OLD');
    const a = firstValueFrom(http.get('/api/a'));
    const b = firstValueFrom(http.get('/api/b'));
    unauthorized('/api/a');
    unauthorized('/api/b');

    const refreshes = ctrl.match(REFRESH);
    expect(refreshes.length).toBe(1);
    refreshes[0].flush({ access_token: 'NEW', expires_in: 900 });
    await settle();

    const ra = ctrl.expectOne('/api/a');
    const rb = ctrl.expectOne('/api/b');
    expect(ra.request.headers.get('Authorization')).toBe('Bearer NEW');
    expect(rb.request.headers.get('Authorization')).toBe('Bearer NEW');
    ra.flush('A');
    rb.flush('B');
    expect(await a).toBe('A');
    expect(await b).toBe('B');
  });

  it('retries with the current token without refreshing if another request already refreshed', async () => {
    await signIn('OLD');
    const slow = firstValueFrom(http.get('/api/slow'));
    const slowReq = ctrl.expectOne('/api/slow');
    await signIn('NEW'); // e.g. the scheduled refresh ran meanwhile
    slowReq.flush({ detail: 'expired' }, { status: 401, statusText: 'Unauthorized' });

    ctrl.expectNone(REFRESH);
    const retry = ctrl.expectOne('/api/slow');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer NEW');
    retry.flush('ok');
    expect(await slow).toBe('ok');
  });

  it('sends the user to /login when the refresh fails, and surfaces the original 401', async () => {
    await signIn('OLD');
    const result = firstValueFrom(http.get('/api/w/1/collections'));
    unauthorized('/api/w/1/collections');
    ctrl.expectOne(REFRESH).flush({ detail: 'session expired' }, { status: 401, statusText: 'Unauthorized' });

    await expect(result).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(auth.accessToken()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/login'], expect.anything());
    ctrl.expectNone('/api/w/1/collections');
  });

  it('retries at most once: a second 401 is returned without another refresh', async () => {
    await signIn('OLD');
    const result = firstValueFrom(http.get('/api/x'));
    unauthorized('/api/x');
    ctrl.expectOne(REFRESH).flush({ access_token: 'NEW', expires_in: 900 });
    await settle();
    unauthorized('/api/x');

    const err = await result.catch((e: unknown) => e);
    expect((err as HttpErrorResponse).status).toBe(401);
    ctrl.expectNone(REFRESH);
  });

  it('does not refresh on 401 from the login endpoint (wrong password)', async () => {
    const result = firstValueFrom(auth.login({ email: 'a@b.c', password: 'nope' }));
    ctrl.expectOne('/api/auth/login').flush({ detail: 'wrong email or password' }, { status: 401, statusText: 'Unauthorized' });
    await expect(result).rejects.toBeInstanceOf(HttpErrorResponse);
    ctrl.expectNone(REFRESH);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('passes non-401 errors straight through', async () => {
    await signIn('T');
    const result = firstValueFrom(http.get('/api/y'));
    ctrl.expectOne('/api/y').flush({ detail: 'requires admin role' }, { status: 403, statusText: 'Forbidden' });
    const err = (await result.catch((e: unknown) => e)) as HttpErrorResponse;
    expect(err.status).toBe(403);
    ctrl.expectNone(REFRESH);
  });
});
