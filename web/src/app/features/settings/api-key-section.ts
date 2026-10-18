import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { ApiKeyStatusOut } from '../../api/models';
import { WorkspacesApi } from '../../api/workspaces.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { ConfirmService } from '../../shared/confirm';
import { formatDate } from '../../shared/format';

/** Anthropic API key: status for everyone; set/replace/remove for admins. The key is write-only. */
@Component({
  selector: 'app-api-key-section',
  imports: [ReactiveFormsModule, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" id="api-key" aria-labelledby="key-h">
      <div class="card-head">
        <h2 id="key-h">Anthropic API key</h2>
        @if (status(); as s) {
          <app-badge [value]="s.configured ? 'ready' : 'none'" [text]="s.configured ? 'configured' : 'not configured'" [dot]="true" />
        }
      </div>
      <div class="card-body stack">
        @if (status(); as s) {
          @if (s.configured) {
            <p class="muted">
              Key ending in <code>{{ s.hint ?? '••••' }}</code>
              @if (s.updated_at) { · updated {{ fmt(s.updated_at) }} }
              · answers use <code>{{ s.model }}</code>.
            </p>
          } @else {
            <p class="muted">
              Questions cannot be answered until a key is added. Answers use <code>{{ s.model }}</code>; the key is encrypted at
              rest and never shown again.
            </p>
          }
        } @else if (loadError()) {
          <p class="field-error">{{ loadError() }}</p>
        } @else {
          <p class="muted">Loading…</p>
        }

        @if (ctx.isAdmin()) {
          <form class="row row-wrap" (submit)="$event.preventDefault(); save()" style="align-items: flex-end">
            <label class="field" style="flex: 1; min-width: 240px">
              <span class="label">{{ status()?.configured ? 'Replace key' : 'API key' }}</span>
              <input class="input mono" type="password" [formControl]="key" autocomplete="off" spellcheck="false"
                placeholder="sk-ant-…" minlength="20" maxlength="300" />
              <span class="hint">The key is checked with Anthropic before it is saved.</span>
            </label>
            <button class="btn btn-primary" type="submit" [disabled]="key.invalid || busy()">
              @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
              Save key
            </button>
            @if (status()?.configured) {
              <button class="btn btn-danger-ghost" type="button" (click)="remove()" [disabled]="busy()">Remove</button>
            }
          </form>
        } @else if (status() && !status()!.configured) {
          <p class="callout" data-tone="info">Ask a workspace admin to add an Anthropic API key.</p>
        }
      </div>
    </section>
  `,
})
export class ApiKeySection implements OnInit {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly api = inject(WorkspacesApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly fmt = formatDate;

  protected readonly status = signal<ApiKeyStatusOut | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly key = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.minLength(20), Validators.maxLength(300)],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.status.set(await firstValueFrom(this.api.apiKey(this.ctx.require())));
    } catch (e) {
      this.loadError.set(apiErrorMessage(e));
    }
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      this.status.set(await firstValueFrom(this.api.setApiKey(this.ctx.require(), this.key.value.trim())));
      this.key.reset('');
      this.toast.success('API key saved.');
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Remove API key?',
      message: 'Nobody in this workspace will be able to ask questions until a new key is added.',
      confirmLabel: 'Remove key',
      danger: true,
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.deleteApiKey(this.ctx.require()));
      this.status.update((s) => (s ? { ...s, configured: false, hint: null, updated_at: null } : s));
      this.toast.success('API key removed.');
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
