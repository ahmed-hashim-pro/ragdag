import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { MeOut, RegisterIn } from '../../api/models';
import { AuthService } from '../../core/auth/auth.service';

/** Sign-up form used for the first account, open sign-up, and invitation sign-up. */
@Component({
  selector: 'app-register-form',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="stack" [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <label class="field">
        <span class="label">Your name</span>
        <input class="input" formControlName="name" autocomplete="name" maxlength="200" required />
      </label>
      <label class="field">
        <span class="label">Email</span>
        <input class="input" type="email" formControlName="email" autocomplete="email" required [readOnly]="!!lockedEmail()"
          [attr.aria-invalid]="touchedInvalid('email')" />
        @if (touchedInvalid('email')) {<span class="field-error">Enter a valid email address.</span>}
      </label>
      <label class="field">
        <span class="label">Password</span>
        <input class="input" type="password" formControlName="password" autocomplete="new-password" required minlength="10"
          aria-describedby="pw-hint" [attr.aria-invalid]="touchedInvalid('password')" />
        <span id="pw-hint" class="hint" [class.field-error]="touchedInvalid('password')">At least 10 characters.</span>
      </label>
      @if (askWorkspace()) {
        <label class="field">
          <span class="label">Workspace name</span>
          <input class="input" formControlName="workspace_name" maxlength="120" placeholder="e.g. Acme docs" />
          <span class="hint">Your own workspace; you can invite others later.</span>
        </label>
      }
      @if (error()) {
        <p class="callout" data-tone="danger" role="alert">{{ error() }}</p>
      }
      <button class="btn btn-primary btn-block" type="submit" [disabled]="busy()">
        @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
        {{ submitLabel() }}
      </button>
    </form>
  `,
})
export class RegisterForm {
  private readonly auth = inject(AuthService);
  readonly lockedEmail = input<string | null>(null);
  readonly inviteToken = input<string | null>(null);
  readonly askWorkspace = input(false);
  readonly submitLabel = input('Create account');
  readonly registered = output<MeOut>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(10), Validators.maxLength(256)]],
    workspace_name: ['', [Validators.maxLength(120)]],
  });

  constructor() {
    effect(() => {
      const email = this.lockedEmail();
      if (email) this.form.controls.email.setValue(email);
    });
  }

  protected touchedInvalid(name: 'email' | 'password'): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || c.dirty);
  }

  protected async submit(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Please fill in every field; the password needs at least 10 characters.');
      return;
    }
    const v = this.form.getRawValue();
    const body: RegisterIn = {
      name: v.name.trim(),
      email: v.email.trim(),
      password: v.password,
      workspace_name: this.askWorkspace() && v.workspace_name.trim() ? v.workspace_name.trim() : null,
      invite_token: this.inviteToken(),
    };
    this.busy.set(true);
    this.error.set(null);
    try {
      this.registered.emit(await firstValueFrom(this.auth.register(body)));
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
