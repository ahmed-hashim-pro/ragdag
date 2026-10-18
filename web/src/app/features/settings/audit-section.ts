import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuditOut } from '../../api/models';
import { WorkspacesApi } from '../../api/workspaces.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { formatDate } from '../../shared/format';

const PAGE = 50;

@Component({
  selector: 'app-audit-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="audit-h">
      <div class="card-head"><h2 id="audit-h">Audit log</h2></div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Details</th></tr>
          </thead>
          <tbody>
            @for (e of events(); track e.id) {
              <tr>
                <td class="nowrap muted">{{ fmt(e.created_at) }}</td>
                <td class="truncate" style="max-width: 200px">{{ e.user_email ?? '—' }}</td>
                <td><code>{{ e.action }}</code></td>
                <td class="truncate" style="max-width: 220px" [title]="e.target ?? ''">{{ e.target ?? '—' }}</td>
                <td class="mono subtle truncate" style="max-width: 260px" [title]="meta(e)">{{ meta(e) }}</td>
              </tr>
            } @empty {
              <tr><td colspan="5" class="muted">{{ loading() ? 'Loading…' : 'No events yet.' }}</td></tr>
            }
          </tbody>
        </table>
      </div>
      @if (hasMore()) {
        <div class="pager">
          <span></span>
          <button type="button" class="btn btn-sm" [disabled]="loading()" (click)="load()">Load older events</button>
        </div>
      }
    </section>
  `,
})
export class AuditSection implements OnInit {
  private readonly ctx = inject(WorkspaceContext);
  private readonly api = inject(WorkspacesApi);
  private readonly toast = inject(ToastService);
  protected readonly fmt = formatDate;
  protected readonly events = signal<AuditOut[]>([]);
  protected readonly loading = signal(false);
  protected readonly hasMore = signal(false);

  ngOnInit(): void {
    void this.load();
  }

  protected meta(e: AuditOut): string {
    const entries = Object.entries(e.meta ?? {});
    return entries.length ? entries.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' ') : '';
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      const before = this.events().at(-1)?.id;
      const page = await firstValueFrom(this.api.audit(this.ctx.require(), PAGE, before));
      this.events.update((list) => [...list, ...page]);
      this.hasMore.set(page.length === PAGE);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.loading.set(false);
    }
  }
}
