import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { InviteOut, ROLES, Role } from '../../api/models';
import { WorkspacesApi } from '../../api/workspaces.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { ConfirmService } from '../../shared/confirm';
import { formatDate, relativeTime } from '../../shared/format';

@Component({
  selector: 'app-invitations-section',
  imports: [ReactiveFormsModule, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="inv-h">
      <div class="card-head"><h2 id="inv-h">Invitations</h2></div>
      <div class="card-body stack">
        <form class="row row-wrap" [formGroup]="form" (ngSubmit)="create()" style="align-items: flex-end">
          <label class="field" style="flex: 2; min-width: 220px">
            <span class="label">Email</span>
            <input class="input" type="email" formControlName="email" autocomplete="off" placeholder="name@example.com" />
          </label>
          <label class="field" style="flex: 1; min-width: 130px">
            <span class="label">Role</span>
            <select class="select" formControlName="role">
              @for (r of roleOptions(); track r) {<option [value]="r">{{ r }}</option>}
            </select>
          </label>
          <button class="btn btn-primary" type="submit" [disabled]="form.invalid || busy()">Create invitation</button>
        </form>

        @if (created(); as inv) {
          <div class="callout" data-tone="success" role="status">
            <div class="callout-body stack">
              <strong>Invitation link for {{ inv.email }}</strong>
              <div class="row row-wrap">
                <input class="input mono" style="flex: 1; min-width: 200px" readonly [value]="inv.invite_url ?? ''" aria-label="Invitation link"
                  (focus)="selectAll($event)" />
                <button type="button" class="btn" (click)="copy(inv.invite_url ?? '')">{{ copied() ? 'Copied ✓' : 'Copy link' }}</button>
              </div>
              <span class="small">Send this link to them now — it will not be shown again. It expires {{ rel(inv.expires_at) }}.</span>
            </div>
            <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" (click)="created.set(null)">✕</button>
          </div>
        }
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            @for (inv of invites(); track inv.id) {
              <tr>
                <td class="truncate" style="max-width: 260px">{{ inv.email }}</td>
                <td><app-badge [value]="inv.role" /></td>
                <td>
                  @if (inv.accepted_at) {
                    <app-badge value="success" text="accepted" />
                  } @else if (isExpired(inv)) {
                    <app-badge value="skipped" text="expired" />
                  } @else {
                    <app-badge value="pending" />
                  }
                </td>
                <td class="nowrap muted">{{ fmt(inv.expires_at) }}</td>
                <td class="actions">
                  @if (!inv.accepted_at) {
                    <button type="button" class="btn btn-sm btn-ghost btn-danger-ghost" (click)="revoke(inv)">Revoke</button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="muted">{{ loaded() ? 'No invitations yet.' : 'Loading…' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class InvitationsSection implements OnInit {
  private readonly ctx = inject(WorkspaceContext);
  private readonly api = inject(WorkspacesApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly fmt = formatDate;
  protected readonly rel = relativeTime;

  protected readonly invites = signal<InviteOut[]>([]);
  protected readonly loaded = signal(false);
  protected readonly created = signal<InviteOut | null>(null);
  protected readonly copied = signal(false);
  protected readonly busy = signal(false);
  protected readonly roleOptions = computed(() => ROLES.filter((r) => r !== 'owner' || this.ctx.isOwner()));
  protected readonly form = inject(FormBuilder).nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    role: ['viewer' as Role, Validators.required],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.invites.set(await firstValueFrom(this.api.invitations(this.ctx.require())));
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.loaded.set(true);
    }
  }

  protected selectAll(e: Event): void {
    (e.target as HTMLInputElement).select();
  }

  protected isExpired(inv: InviteOut): boolean {
    return new Date(inv.expires_at).getTime() < Date.now();
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    try {
      const v = this.form.getRawValue();
      const inv = await firstValueFrom(this.api.invite(this.ctx.require(), { email: v.email.trim(), role: v.role }));
      this.created.set(inv);
      this.copied.set(false);
      this.invites.update((list) => [inv, ...list]);
      this.form.reset({ email: '', role: 'viewer' });
    } catch (e) {
      this.toast.error(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
    } catch {
      this.toast.error('Could not copy automatically; select the link and copy it.');
    }
  }

  protected async revoke(inv: InviteOut): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Revoke invitation?',
      message: `The link sent to ${inv.email} will stop working.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.revokeInvite(this.ctx.require(), inv.id));
      this.invites.update((list) => list.filter((x) => x.id !== inv.id));
      if (this.created()?.id === inv.id) this.created.set(null);
      this.toast.success('Invitation revoked.');
    } catch (e) {
      this.toast.error(e);
    }
  }
}
