import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { API, params } from './http-context';
import {
  ApiKeyStatusOut,
  AuditOut,
  InviteIn,
  InviteOut,
  MemberOut,
  Role,
  UsageOut,
  WorkspaceOut,
} from './models';

@Injectable({ providedIn: 'root' })
export class WorkspacesApi {
  private readonly http = inject(HttpClient);

  private base(ws: string): string {
    return `${API}/w/${ws}`;
  }

  create(name: string): Observable<WorkspaceOut> {
    return this.http.post<WorkspaceOut>(`${API}/workspaces`, { name });
  }

  get(ws: string): Observable<WorkspaceOut> {
    return this.http.get<WorkspaceOut>(this.base(ws));
  }

  rename(ws: string, name: string): Observable<WorkspaceOut> {
    return this.http.patch<WorkspaceOut>(this.base(ws), { name });
  }

  delete(ws: string): Observable<void> {
    return this.http.delete<void>(this.base(ws));
  }

  members(ws: string): Observable<MemberOut[]> {
    return this.http.get<MemberOut[]>(`${this.base(ws)}/members`);
  }

  changeRole(ws: string, userId: string, role: Role): Observable<MemberOut> {
    return this.http.patch<MemberOut>(`${this.base(ws)}/members/${userId}`, { role });
  }

  /** Remove a member — or leave, when `userId` is the caller. */
  removeMember(ws: string, userId: string): Observable<void> {
    return this.http.delete<void>(`${this.base(ws)}/members/${userId}`);
  }

  invitations(ws: string): Observable<InviteOut[]> {
    return this.http.get<InviteOut[]>(`${this.base(ws)}/invitations`);
  }

  invite(ws: string, body: InviteIn): Observable<InviteOut> {
    return this.http.post<InviteOut>(`${this.base(ws)}/invitations`, body);
  }

  revokeInvite(ws: string, inviteId: string): Observable<void> {
    return this.http.delete<void>(`${this.base(ws)}/invitations/${inviteId}`);
  }

  apiKey(ws: string): Observable<ApiKeyStatusOut> {
    return this.http.get<ApiKeyStatusOut>(`${this.base(ws)}/api-key`);
  }

  setApiKey(ws: string, apiKey: string): Observable<ApiKeyStatusOut> {
    return this.http.put<ApiKeyStatusOut>(`${this.base(ws)}/api-key`, { api_key: apiKey });
  }

  deleteApiKey(ws: string): Observable<void> {
    return this.http.delete<void>(`${this.base(ws)}/api-key`);
  }

  audit(ws: string, limit = 50, before?: number): Observable<AuditOut[]> {
    return this.http.get<AuditOut[]>(`${this.base(ws)}/audit`, { params: params({ limit, before }) });
  }

  usage(ws: string, days = 30): Observable<UsageOut> {
    return this.http.get<UsageOut>(`${this.base(ws)}/usage`, { params: params({ days }) });
  }
}
