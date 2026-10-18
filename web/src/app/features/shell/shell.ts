import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';

import { AuthService } from '../../core/auth/auth.service';
import { ThemeService } from '../../core/theme.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { inputValue } from '../../shared/format';
import { NewWorkspaceDialog } from './new-workspace-dialog';

const NEW_WS = '__new__';

/** Authenticated layout: header with workspace switcher, primary nav, theme and account. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NewWorkspaceDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './shell.css',
  template: `
    <header class="header">
      <a class="brand" [routerLink]="['/']" aria-label="ragdag home">
        <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="var(--accent)" />
          <circle cx="9" cy="10" r="3.2" fill="var(--accent-fg)" /><circle cx="23" cy="10" r="3.2" fill="var(--accent-fg)" />
          <circle cx="16" cy="23" r="3.2" fill="var(--accent-fg)" />
          <path d="M9 10 16 23M23 10 16 23M9 10h14" stroke="var(--accent-fg)" stroke-width="2" fill="none" />
        </svg>
        <span class="brand-name">ragdag</span>
      </a>

      @if (auth.memberships().length) {
        <label class="ws-switch">
          <span class="sr-only">Workspace</span>
          <select class="select input-sm" [value]="selectValue()" (change)="switchWorkspace($event)">
            @for (m of auth.memberships(); track m.workspace_id) {
              <option [value]="m.workspace_id" [selected]="m.workspace_id === selectValue()">{{ m.workspace_name }}</option>
            }
            <option [value]="NEW_WS">+ New workspace…</option>
          </select>
        </label>
      }

      @if (wsId(); as ws) {
        <nav class="nav" aria-label="Primary">
          <a class="nav-link" [routerLink]="['/w', ws, 'ask']" routerLinkActive="active" ariaCurrentWhenActive="page">Ask</a>
          <a class="nav-link" [routerLink]="['/w', ws, 'collections']" routerLinkActive="active" ariaCurrentWhenActive="page">Collections</a>
          <a class="nav-link" [routerLink]="['/w', ws, 'pipelines']" routerLinkActive="active" ariaCurrentWhenActive="page">Pipelines</a>
          <a class="nav-link" [routerLink]="['/w', ws, 'settings']" routerLinkActive="active" ariaCurrentWhenActive="page">Settings</a>
        </nav>
      }
      <span class="spacer"></span>

      <button type="button" class="btn btn-ghost btn-icon" (click)="theme.cycle()" [attr.aria-label]="themeLabel()" [title]="themeLabel()">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          @switch (theme.mode()) {
            @case ('light') {
              <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            }
            @case ('dark') {
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            }
            @default {
              <circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
            }
          }
        </svg>
      </button>
      <a class="btn btn-ghost user" [routerLink]="['/account']" routerLinkActive="active" [attr.aria-label]="'Account: ' + (auth.user()?.name ?? '')">
        <span class="avatar" aria-hidden="true">{{ initials() }}</span>
        <span class="user-name truncate">{{ auth.user()?.name }}</span>
      </a>
    </header>

    <main #main id="main" class="main" tabindex="-1">
      <router-outlet />
    </main>

    <app-new-workspace-dialog [open]="creating()" (closed)="creating.set(false)" />
  `,
})
export class Shell {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  private readonly ctx = inject(WorkspaceContext);
  private readonly router = inject(Router);
  protected readonly NEW_WS = NEW_WS;
  protected readonly creating = signal(false);
  private readonly main = viewChild.required<ElementRef<HTMLElement>>('main');
  private lastPath = '';

  constructor() {
    // Pages scroll inside <main>; start each new page at the top (but not on query-param changes).
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((e) => {
        const path = e.urlAfterRedirects.split(/[?#]/)[0];
        if (path !== this.lastPath) this.main().nativeElement.scrollTop = 0;
        this.lastPath = path;
      });
  }

  /** The workspace whose nav is shown (stays on the last one while on /account). */
  protected readonly wsId = computed(() => {
    const id = this.ctx.wsId();
    return id && this.auth.memberships().some((m) => m.workspace_id === id) ? id : null;
  });
  protected readonly selectValue = computed(() => this.wsId() ?? '');

  protected readonly initials = computed(() => {
    const name = this.auth.user()?.name ?? '';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase() || '?';
  });

  protected readonly themeLabel = computed(() => `Theme: ${this.theme.mode()} (click to change)`);

  protected switchWorkspace(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = inputValue(event);
    if (value === NEW_WS) {
      select.value = this.selectValue();
      this.creating.set(true);
      return;
    }
    void this.router.navigate(['/w', value, 'ask']);
  }
}
