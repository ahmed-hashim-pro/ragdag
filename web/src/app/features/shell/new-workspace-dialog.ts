import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { WorkspacesApi } from '../../api/workspaces.service';
import { AuthService } from '../../core/auth/auth.service';
import { ToastService } from '../../core/toast.service';

/** Modal form that creates a workspace and switches to it. */
@Component({
  selector: 'app-new-workspace-dialog',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg class="modal" aria-labelledby="nw-title" (close)="closed.emit()">
      <form class="modal-inner" (submit)="$event.preventDefault(); create()">
        <h2 id="nw-title" class="modal-title">New workspace</h2>
        <p class="modal-text">A workspace has its own collections, members, and Anthropic API key.</p>
        <label class="field">
          <span class="label">Name</span>
          <input class="input" [formControl]="name" maxlength="120" autocomplete="off" required />
        </label>
        @if (error()) {
          <p class="field-error" role="alert">{{ error() }}</p>
        }
        <div class="modal-actions">
          <button type="button" class="btn" (click)="dlg.close()">Cancel</button>
          <button type="submit" class="btn btn-primary" [disabled]="name.invalid || busy()">
            @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
            Create
          </button>
        </div>
      </form>
    </dialog>
  `,
})
export class NewWorkspaceDialog {
  private readonly api = inject(WorkspacesApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);

  readonly open = input.required<boolean>();
  readonly closed = output<void>();
  protected readonly name = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(120)] });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg().nativeElement;
      if (this.open() && !el.open) {
        this.name.reset('');
        this.error.set(null);
        el.showModal?.();
      } else if (!this.open() && el.open) {
        el.close();
      }
    });
  }

  protected async create(): Promise<void> {
    const name = this.name.value.trim();
    if (!name) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const ws = await firstValueFrom(this.api.create(name));
      await this.auth.reloadMe();
      this.dlg().nativeElement.close();
      this.toast.success(`Workspace “${ws.name}” created.`);
      await this.router.navigate(['/w', ws.id, 'collections']);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
