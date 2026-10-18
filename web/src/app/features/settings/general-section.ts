import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { WorkspacesApi } from '../../api/workspaces.service';
import { AuthService } from '../../core/auth/auth.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { ConfirmService } from '../../shared/confirm';

/** Workspace name (admin), leave, and delete (owner). */
@Component({
  selector: 'app-general-section',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="general-h">
      <div class="card-head"><h2 id="general-h">Workspace</h2></div>
      <div class="card-body stack">
        <form class="row row-wrap" (ngSubmit)="rename()" style="align-items: flex-end">
          <label class="field" style="flex: 1; min-width: 220px">
            <span class="label">Name</span>
            <input class="input" [formControl]="name" maxlength="120" [readOnly]="!ctx.isAdmin()" />
          </label>
          @if (ctx.isAdmin()) {
            <button class="btn btn-primary" type="submit" [disabled]="name.invalid || name.value.trim() === ctx.workspaceName() || busy()">
              Save name
            </button>
          }
        </form>

        <div class="callout" data-tone="danger">
          <div class="callout-body stack">
            <strong>Danger zone</strong>
            <div class="row row-wrap">
              <span class="spacer muted small">Leaving removes your access to this workspace's collections and conversations.</span>
              <button type="button" class="btn btn-danger-ghost" (click)="leave()">Leave workspace</button>
            </div>
            @if (ctx.isOwner()) {
              <div class="row row-wrap">
                <span class="spacer muted small">Deleting removes every collection, document, and conversation. This cannot be undone.</span>
                <button type="button" class="btn btn-danger" (click)="remove()">Delete workspace</button>
              </div>
            }
          </div>
        </div>
      </div>
    </section>
  `,
})
export class GeneralSection {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly api = inject(WorkspacesApi);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);

  protected readonly busy = signal(false);
  protected readonly name = new FormControl(this.ctx.workspaceName(), {
    nonNullable: true,
    validators: [Validators.required, Validators.maxLength(120)],
  });

  protected async rename(): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.rename(this.ctx.require(), this.name.value.trim()));
      await this.auth.reloadMe();
      this.toast.success('Workspace renamed.');
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async leave(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Leave workspace?',
      message: `You will lose access to “${this.ctx.workspaceName()}” until someone invites you again.`,
      confirmLabel: 'Leave',
      danger: true,
    });
    const me = this.auth.user();
    if (!ok || !me) return;
    try {
      await firstValueFrom(this.api.removeMember(this.ctx.require(), me.id));
      await this.auth.reloadMe();
      this.toast.success('You left the workspace.');
      await this.router.navigate(['/']);
    } catch (e) {
      this.toast.error(e);
    }
  }

  protected async remove(): Promise<void> {
    const name = this.ctx.workspaceName();
    const ok = await this.confirm.confirm({
      title: 'Delete workspace?',
      message: `This permanently deletes “${name}” with all its collections, documents, sources and conversations.`,
      confirmLabel: 'Delete workspace',
      danger: true,
      typeToConfirm: name,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.delete(this.ctx.require()));
      await this.auth.reloadMe();
      this.toast.success('Workspace deleted.');
      await this.router.navigate(['/']);
    } catch (e) {
      this.toast.error(e);
    }
  }
}
