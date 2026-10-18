import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';
import { WorkspaceContext } from '../workspace-context';

/** Signed-in users only; others go to /login?next=… */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  if (auth.isAuthenticated()) return true;
  return inject(Router).createUrlTree(['/login'], {
    queryParams: state.url && state.url !== '/' ? { next: state.url } : {},
  });
};

/** Signed-out users only (login page); signed-in users go home. */
export const guestGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.isAuthenticated() ? inject(Router).createUrlTree(['/']) : true;
};

/** `/` → the last-used (or first) workspace, or the welcome page when there are none. */
export const homeRedirectGuard: CanActivateFn = () => {
  const ctx = inject(WorkspaceContext);
  const router = inject(Router);
  const target = ctx.preferredWorkspaceId();
  return target ? router.createUrlTree(['/w', target, 'ask']) : router.createUrlTree(['/welcome']);
};

/** `/w/:wsId/…` must be one of the user's workspaces; selects it as the current one. */
export const workspaceGuard: CanActivateFn = (route) => {
  const ctx = inject(WorkspaceContext);
  const wsId = route.paramMap.get('wsId');
  if (wsId && ctx.select(wsId)) return true;
  return inject(Router).createUrlTree(['/']);
};
