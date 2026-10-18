import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { MemberOut, ROLE_RANK, ROLES, Role } from '../../api/models';
import { WorkspacesApi } from '../../api/workspaces.service';
import { AuthService } from '../../core/auth/auth.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { ConfirmService } from '../../shared/confirm';
import { formatDate, inputValue } from '../../shared/format';

/**
 * Mirrors the server's rules (the server still decides): admins manage editors and viewers;
 * only owners touch owners or grant ownership.
 */
export function canManage(myRole: Role | null, target: Role, newRole?: Role): boolean {
  if (!myRole || ROLE_RANK[myRole] < ROLE_RANK.admin) return false;
  if (myRole === 'owner') return true;
  if (target === 'owner' || newRole === 'owner') return false;
  return ROLE_RANK[target] < ROLE_RANK[myRole];
}

@Component({
  selector: 'app-members-section',
  imports: [Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="members-h">
      <div class="card-head">
        <h2 id="members-h">Members</h2>
        <span class="muted small">{{ members().length }} {{ members().length === 1 ? 'person' : 'people' }}</span>
      </div>
      @if (error()) {
        <p class="card-body field-error">{{ error() }}</p>
      }
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span class="sr-only">Actions</span></th></tr>
          </thead>
          <tbody>
            @for (m of members(); track m.user_id) {
              <tr>
                <td>
                  <div class="cell-title truncate">{{ m.name }} @if (m.user_id === myId()) {<span class="subtle">(you)</span>}</div>
                  <div class="subtle truncate">{{ m.email }}</div>
                </td>
                <td>
                  @if (canManage(ctx.role(), m.role) && m.user_id !== myId()) {
                    <label>
                      <span class="sr-only">Role for {{ m.name }}</span>
                      <select class="select input-sm" style="width: auto" [value]="m.role" [disabled]="busyId() === m.user_id"
                        (change)="changeRole(m, $event)">
                        @for (r of roleOptions(); track r) {
                          <option [value]="r" [selected]="r === m.role">{{ r }}</option>
                        }
                      </select>
                    </label>
                  } @else {
                    <app-badge [value]="m.role" />
                  }
                </td>
                <td class="nowrap muted">{{ fmt(m.joined_at) }}</td>
                <td class="actions">
                  @if (m.user_id !== myId() && canManage(ctx.role(), m.role)) {
                    <button type="button" class="btn btn-sm btn-ghost btn-danger-ghost" (click)="remove(m)" [disabled]="busyId() === m.user_id">
                      Remove
                    </button>
                  }
                </td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="muted">Loading members…</td></tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class MembersSection implements OnInit {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly auth = inject(AuthService);
  private readonly api = inject(WorkspacesApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly fmt = formatDate;
  protected readonly canManage = canManage;

  protected readonly members = signal<MemberOut[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);
  protected readonly myId = computed(() => this.auth.user()?.id ?? null);
  protected readonly roleOptions = computed(() => ROLES.filter((r) => r !== 'owner' || this.ctx.isOwner()));

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.members.set(await firstValueFrom(this.api.members(this.ctx.require())));
      this.error.set(null);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    }
  }

  protected async changeRole(m: MemberOut, event: Event): Promise<void> {
    const select = event.target as HTMLSelectElement;
    const role = inputValue(event) as Role;
    if (role === m.role) return;
    this.busyId.set(m.user_id);
    try {
      const updated = await firstValueFrom(this.api.changeRole(this.ctx.require(), m.user_id, role));
      this.members.update((list) => list.map((x) => (x.user_id === m.user_id ? updated : x)));
      this.toast.success(`${m.name} is now ${updated.role}.`);
    } catch (e) {
      select.value = m.role;
      this.toast.error(e);
    } finally {
      this.busyId.set(null);
    }
  }

  protected async remove(m: MemberOut): Promise<void> {
    const ok = await this.confirm.confirm({
      title: `Remove ${m.name}?`,
      message: `${m.email} will lose access to this workspace.`,
      confirmLabel: 'Remove member',
      danger: true,
    });
    if (!ok) return;
    this.busyId.set(m.user_id);
    try {
      await firstValueFrom(this.api.removeMember(this.ctx.require(), m.user_id));
      this.members.update((list) => list.filter((x) => x.user_id !== m.user_id));
      this.toast.success(`${m.name} was removed.`);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busyId.set(null);
    }
  }
}
