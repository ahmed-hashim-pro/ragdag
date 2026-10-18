import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { BootstrapOut } from '../../api/models';
import { AuthService } from '../../core/auth/auth.service';
import { BrandMark } from './brand-mark';
import { RegisterForm } from './register-form';

/** Only allow in-app redirect targets (no protocol-relative or absolute URLs). */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, RegisterForm, BrandMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth.css',
  template: `
    <main id="main" class="card auth-card">
      <app-brand-mark />
      @if (!boot()) {
        <p class="muted" role="status">Loading…</p>
      } @else if (mode() === 'register') {
        <div>
          <h1>{{ boot()!.needs_setup ? 'Create the first account' : 'Create an account' }}</h1>
          <p class="muted small" style="margin-top: 4px">
            @if (boot()!.needs_setup) {
              This account becomes the owner of the first workspace.
            } @else {
              You will get your own workspace.
            }
          </p>
        </div>
        <app-register-form [askWorkspace]="true" (registered)="done()"
          [submitLabel]="boot()!.needs_setup ? 'Create account and workspace' : 'Create account'" />
        @if (!boot()!.needs_setup) {
          <p class="auth-foot">Already have an account? <button type="button" class="link-btn" (click)="mode.set('login')">Sign in</button></p>
        }
      } @else {
        <div>
          <h1>Sign in</h1>
          @if (expired()) {
            <p class="muted small" style="margin-top: 4px" role="status">Your session ended. Please sign in again.</p>
          }
        </div>
        <form class="stack" [formGroup]="form" (ngSubmit)="login()" novalidate>
          <label class="field">
            <span class="label">Email</span>
            <input class="input" type="email" formControlName="email" autocomplete="username" required autofocus />
          </label>
          <label class="field">
            <span class="label">Password</span>
            <input class="input" type="password" formControlName="password" autocomplete="current-password" required />
          </label>
          @if (error()) {
            <p class="callout" data-tone="danger" role="alert">{{ error() }}</p>
          }
          <button class="btn btn-primary btn-block" type="submit" [disabled]="busy()">
            @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
            Sign in
          </button>
        </form>
        @if (boot()!.allow_signup) {
          <p class="auth-foot">New here? <button type="button" class="link-btn" (click)="mode.set('register')">Create an account</button></p>
        } @else {
          <p class="auth-foot">Accounts are by invitation. Ask a workspace admin for an invite link.</p>
        }
      }
    </main>
  `,
})
export class LoginPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Query params (component input binding). */
  readonly next = input<string | undefined>();
  readonly expiredParam = input<string | undefined>(undefined, { alias: 'expired' });

  protected readonly boot = signal<BootstrapOut | null>(null);
  protected readonly mode = signal<'login' | 'register'>('login');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly expired = computed(() => !!this.expiredParam());
  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', Validators.required],
  });

  async ngOnInit(): Promise<void> {
    try {
      const b = await firstValueFrom(this.auth.bootstrap());
      this.boot.set(b);
      if (b.needs_setup) this.mode.set('register');
    } catch (e) {
      this.boot.set({ needs_setup: false, allow_signup: false, max_upload_mb: 0, upload_extensions: [] });
      this.error.set(apiErrorMessage(e));
    }
  }

  protected async login(): Promise<void> {
    if (this.form.invalid) {
      this.error.set('Enter your email and password.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const v = this.form.getRawValue();
      await firstValueFrom(this.auth.login({ email: v.email.trim(), password: v.password }));
      await this.done();
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async done(): Promise<void> {
    await this.router.navigateByUrl(safeNext(this.next()));
  }
}
