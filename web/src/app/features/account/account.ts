import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { AuthService } from '../../core/auth/auth.service';
import { ToastService } from '../../core/toast.service';
import { Badge } from '../../shared/badge';
import { formatDate } from '../../shared/format';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const a = group.get('new_password')?.value;
  const b = group.get('confirm')?.value;
  return a && b && a !== b ? { mismatch: true } : null;
}

@Component({
  selector: 'app-account',
  imports: [ReactiveFormsModule, RouterLink, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" style="max-width: 760px">
      <div class="page-head">
        <div class="page-title">
          <h1>Account</h1>
          <p>Your profile, password, and workspaces.</p>
        </div>
        <button type="button" class="btn" (click)="auth.logout()">Sign out</button>
      </div>

      <div class="stack-lg">
        @if (auth.user(); as u) {
          <section class="card" aria-labelledby="profile-h">
            <div class="card-head"><h2 id="profile-h">Profile</h2></div>
            <dl class="card-body form-grid" style="margin: 0">
              <div><dt class="label">Name</dt><dd class="muted" style="margin: 4px 0 0">{{ u.name }}</dd></div>
              <div><dt class="label">Email</dt><dd class="muted" style="margin: 4px 0 0">{{ u.email }}</dd></div>
              <div><dt class="label">Member since</dt><dd class="muted" style="margin: 4px 0 0">{{ fmt(u.created_at) }}</dd></div>
            </dl>
          </section>
        }

        <section class="card" aria-labelledby="ws-h">
          <div class="card-head"><h2 id="ws-h">Workspaces</h2></div>
          <ul class="card-body stack" style="list-style: none; margin: 0">
            @for (m of auth.memberships(); track m.workspace_id) {
              <li class="row">
                <a class="truncate" [routerLink]="['/w', m.workspace_id, 'ask']">{{ m.workspace_name }}</a>
                <span class="spacer"></span>
                <app-badge [value]="m.role" />
              </li>
            } @empty {
              <li class="muted">You are not in any workspace. <a routerLink="/welcome">Create one</a>.</li>
            }
          </ul>
        </section>

        <section class="card" aria-labelledby="pw-h">
          <div class="card-head"><h2 id="pw-h">Change password</h2></div>
          <form class="card-body stack" [formGroup]="pw" (ngSubmit)="changePassword()" novalidate>
            <input type="email" class="sr-only" autocomplete="username" [value]="auth.user()?.email ?? ''" tabindex="-1" aria-hidden="true" readonly />
            <label class="field">
              <span class="label">Current password</span>
              <input class="input" type="password" formControlName="current_password" autocomplete="current-password" required />
            </label>
            <div class="form-grid">
              <label class="field">
                <span class="label">New password</span>
                <input class="input" type="password" formControlName="new_password" autocomplete="new-password" minlength="10" required />
                <span class="hint">At least 10 characters.</span>
              </label>
              <label class="field">
                <span class="label">Repeat new password</span>
                <input class="input" type="password" formControlName="confirm" autocomplete="new-password" required
                  [attr.aria-invalid]="pw.hasError('mismatch')" />
                @if (pw.hasError('mismatch')) {<span class="field-error">The passwords do not match.</span>}
              </label>
            </div>
            <p class="hint">Changing your password signs out your other sessions.</p>
            @if (error()) {<p class="callout" data-tone="danger" role="alert">{{ error() }}</p>}
            <div class="form-actions">
              <button class="btn btn-primary" type="submit" [disabled]="pw.invalid || busy()">
                @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
                Change password
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  `,
})
export class AccountPage {
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly fmt = formatDate;
  protected readonly pw = inject(FormBuilder).nonNullable.group(
    {
      current_password: ['', Validators.required],
      new_password: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(256)]],
      confirm: ['', Validators.required],
    },
    { validators: passwordsMatch },
  );

  protected async changePassword(): Promise<void> {
    const v = this.pw.getRawValue();
    const email = this.auth.user()?.email;
    this.busy.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.auth.changePassword({ current_password: v.current_password, new_password: v.new_password }));
      // The server revokes every refresh token, including this tab's: sign in again silently
      // so this session keeps working past the access token's lifetime.
      if (email) {
        try {
          await firstValueFrom(this.auth.login({ email, password: v.new_password }));
        } catch {
          // Not fatal; the user will be asked to sign in when the access token expires.
        }
      }
      this.pw.reset();
      this.toast.success('Password changed. Other sessions were signed out.');
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
