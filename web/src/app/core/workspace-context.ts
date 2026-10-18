import { Injectable, computed, inject, signal } from '@angular/core';

import { MembershipOut, ROLE_RANK, Role } from '../api/models';
import { AuthService } from './auth/auth.service';

const LAST_WS_KEY = 'ragdag.lastWorkspace';

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_WS_KEY);
  } catch {
    return null;
  }
}

function writeLast(id: string): void {
  try {
    localStorage.setItem(LAST_WS_KEY, id);
  } catch {
    // storage unavailable (private mode): not important
  }
}

/** The workspace the user is currently looking at, and their role in it. */
@Injectable({ providedIn: 'root' })
export class WorkspaceContext {
  private readonly auth = inject(AuthService);
  private readonly _wsId = signal<string | null>(null);

  readonly wsId = this._wsId.asReadonly();
  readonly membership = computed<MembershipOut | null>(() => {
    const id = this._wsId();
    return this.auth.memberships().find((m) => m.workspace_id === id) ?? null;
  });
  readonly role = computed<Role | null>(() => this.membership()?.role ?? null);
  readonly workspaceName = computed(() => this.membership()?.workspace_name ?? '');

  readonly canEdit = computed(() => this.atLeast('editor'));
  readonly isAdmin = computed(() => this.atLeast('admin'));
  readonly isOwner = computed(() => this.role() === 'owner');

  atLeast(min: Role): boolean {
    const role = this.role();
    return role !== null && ROLE_RANK[role] >= ROLE_RANK[min];
  }

  /** Select a workspace if the user belongs to it. Returns false otherwise. */
  select(id: string): boolean {
    if (!this.auth.memberships().some((m) => m.workspace_id === id)) return false;
    this._wsId.set(id);
    writeLast(id);
    return true;
  }

  /** Where `/` should go: the last workspace used, else the first membership. */
  preferredWorkspaceId(): string | null {
    const memberships = this.auth.memberships();
    const last = readLast();
    if (last && memberships.some((m) => m.workspace_id === last)) return last;
    return memberships[0]?.workspace_id ?? null;
  }

  /** The current workspace id; throws if a workspace-scoped page is shown without one. */
  require(): string {
    const id = this._wsId();
    if (!id) throw new Error('No workspace selected');
    return id;
  }
}
