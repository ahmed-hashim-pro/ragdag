import { Routes } from '@angular/router';

import { authGuard, guestGuard, homeRedirectGuard, workspaceGuard } from './core/auth/auth.guards';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · ragdag',
    loadComponent: () => import('./features/auth/login').then((m) => m.LoginPage),
  },
  {
    path: 'invite/:token',
    title: 'Invitation · ragdag',
    loadComponent: () => import('./features/auth/invite').then((m) => m.InvitePage),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', canActivate: [homeRedirectGuard], children: [] },
      {
        path: 'welcome',
        title: 'Welcome · ragdag',
        loadComponent: () => import('./features/shell/welcome').then((m) => m.WelcomePage),
      },
      {
        path: 'account',
        title: 'Account · ragdag',
        loadComponent: () => import('./features/account/account').then((m) => m.AccountPage),
      },
      {
        path: 'w/:wsId',
        canActivate: [workspaceGuard],
        loadComponent: () => import('./features/shell/workspace-host').then((m) => m.WorkspaceHost),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'ask' },
          {
            path: 'ask',
            title: 'Ask · ragdag',
            loadComponent: () => import('./features/ask/ask-page').then((m) => m.AskPage),
          },
          {
            path: 'collections',
            title: 'Collections · ragdag',
            loadComponent: () => import('./features/collections/collections-page').then((m) => m.CollectionsPage),
          },
          {
            path: 'collections/:collectionId',
            loadComponent: () => import('./features/collections/collection-detail').then((m) => m.CollectionDetail),
            children: [
              { path: '', pathMatch: 'full', redirectTo: 'documents' },
              {
                path: 'documents',
                title: 'Documents · ragdag',
                loadComponent: () => import('./features/collections/documents-tab').then((m) => m.DocumentsTab),
              },
              {
                path: 'sources',
                title: 'Sources · ragdag',
                loadComponent: () => import('./features/collections/sources-tab').then((m) => m.SourcesTab),
              },
              {
                path: 'search',
                title: 'Search · ragdag',
                loadComponent: () => import('./features/collections/search-tab').then((m) => m.SearchTab),
              },
              {
                path: 'settings',
                title: 'Collection settings · ragdag',
                loadComponent: () =>
                  import('./features/collections/collection-settings-tab').then((m) => m.CollectionSettingsTab),
              },
            ],
          },
          {
            path: 'pipelines',
            title: 'Pipelines · ragdag',
            loadComponent: () => import('./features/pipelines/runs-page').then((m) => m.RunsPage),
          },
          {
            path: 'pipelines/:runId',
            title: 'Pipeline run · ragdag',
            loadComponent: () => import('./features/pipelines/run-detail').then((m) => m.RunDetailPage),
          },
          {
            path: 'settings',
            title: 'Settings · ragdag',
            loadComponent: () => import('./features/settings/settings-page').then((m) => m.SettingsPage),
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
