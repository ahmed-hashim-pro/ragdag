import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { WorkspacesApi } from '../../api/workspaces.service';
import { AuthService } from '../../core/auth/auth.service';
import { WorkspaceContext } from '../../core/workspace-context';

/** Shown to a signed-in user who belongs to no workspace (e.g. after leaving the last one). */
@Component({
  selector: 'app-welcome',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page" style="max-width: 560px">
      <div class="card card-pad stack">
        <h1>Welcome{{ auth.user() ? ', ' + auth.user()!.name : '' }}</h1>
        <p class="muted">
          You are not a member of any workspace yet. Create one to start adding documents — or ask a
          workspace admin to send you an invitation link.
        </p>
        <form class="stack" (ngSubmit)="create()">
          <label class="field">
            <span class="label">Workspace name</span>
            <input class="input" [formControl]="name" maxlength="120" placeholder="e.g. Engineering" />
          </label>
          @if (error()) {
            <p class="field-error" role="alert">{{ error() }}</p>
          }
          <div class="form-actions">
            <button class="btn btn-primary" type="submit" [disabled]="name.invalid || busy()">Create workspace</button>
          </div>
        </form>
      </div>
    </div>
  `,
})
export class WelcomePage {
  protected readonly auth = inject(AuthService);
  private readonly api = inject(WorkspacesApi);
  private readonly router = inject(Router);
  private readonly ctx = inject(WorkspaceContext);
  protected readonly name = new FormControl('', { nonNullable: true, validators: [Validators.required] });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    const existing = this.ctx.preferredWorkspaceId();
    if (existing) void this.router.navigate(['/w', existing, 'ask']);
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const ws = await firstValueFrom(this.api.create(this.name.value.trim()));
      await this.auth.reloadMe();
      await this.router.navigate(['/w', ws.id, 'collections']);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
