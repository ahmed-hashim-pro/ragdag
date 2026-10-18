import { ChangeDetectionStrategy, Component, OnInit, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { InvitePreviewOut } from '../../api/models';
import { AuthService } from '../../core/auth/auth.service';
import { ToastService } from '../../core/toast.service';
import { BrandMark } from './brand-mark';
import { RegisterForm } from './register-form';

@Component({
  selector: 'app-invite',
  imports: [RouterLink, RegisterForm, BrandMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth.css',
  template: `
    <main id="main" class="card auth-card">
      <app-brand-mark />
      @if (loadError()) {
        <h1>Invitation unavailable</h1>
        <p class="callout" data-tone="danger" role="alert">{{ loadError() }}</p>
        <a class="btn" routerLink="/">Go to ragdag</a>
      } @else if (!preview()) {
        <p class="muted" role="status">Checking your invitation…</p>
      } @else {
        @let p = preview()!;
        <div>
          <h1>Join {{ p.workspace_name }}</h1>
          <p class="muted" style="margin-top: 4px">You have been invited as <strong>{{ p.role }}</strong> ({{ p.email }}).</p>
        </div>

        @if (auth.isAuthenticated()) {
          @if (auth.user()?.email?.toLowerCase() !== p.email.toLowerCase()) {
            <p class="callout" data-tone="warning">
              You are signed in as {{ auth.user()?.email }}, but this invitation is for {{ p.email }}. Sign out and
              sign in with the invited account to accept it.
            </p>
            <button type="button" class="btn" (click)="signOut()">Sign out</button>
          } @else {
            @if (error()) {<p class="callout" data-tone="danger" role="alert">{{ error() }}</p>}
            <button type="button" class="btn btn-primary btn-block" [disabled]="busy()" (click)="accept()">
              @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
              Accept invitation
            </button>
          }
        } @else if (p.user_exists) {
          <p class="muted">You already have an account. Sign in to accept the invitation.</p>
          <a class="btn btn-primary btn-block" [routerLink]="['/login']" [queryParams]="{ next: '/invite/' + token() }">Sign in to accept</a>
        } @else {
          <app-register-form [lockedEmail]="p.email" [inviteToken]="token()" submitLabel="Create account and join"
            (registered)="joined()" />
          <p class="auth-foot">Have an account with this email?
            <a [routerLink]="['/login']" [queryParams]="{ next: '/invite/' + token() }">Sign in</a></p>
        }
      }
    </main>
  `,
})
export class InvitePage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  readonly token = input.required<string>();

  protected readonly preview = signal<InvitePreviewOut | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    try {
      this.preview.set(await firstValueFrom(this.auth.invitePreview(this.token())));
    } catch (e) {
      this.loadError.set(apiErrorMessage(e, 'This invitation is invalid or has expired.'));
    }
  }

  protected async accept(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const me = await firstValueFrom(this.auth.acceptInvite({ token: this.token() }));
      this.toast.success(`You joined ${this.preview()?.workspace_name ?? 'the workspace'}.`);
      const ws = me.memberships.find((m) => m.workspace_id === this.preview()?.workspace_id) ?? me.memberships.at(-1);
      await this.router.navigate(ws ? ['/w', ws.workspace_id, 'ask'] : ['/']);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  /** Registration with an invite token joins the workspace directly. */
  protected async joined(): Promise<void> {
    this.toast.success(`Welcome to ${this.preview()?.workspace_name ?? 'ragdag'}!`);
    await this.router.navigate(['/']);
  }

  protected async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigate(['/invite', this.token()]);
  }
}
