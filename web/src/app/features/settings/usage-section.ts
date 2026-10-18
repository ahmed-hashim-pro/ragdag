import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { UsageOut } from '../../api/models';
import { WorkspacesApi } from '../../api/workspaces.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { formatNumber, inputValue } from '../../shared/format';

@Component({
  selector: 'app-usage-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" aria-labelledby="usage-h">
      <div class="card-head">
        <h2 id="usage-h">Usage</h2>
        <label class="row gap-sm small">
          <span class="muted">Period</span>
          <select class="select input-sm" style="width: auto" [value]="days()" (change)="setDays($event)">
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="365">1 year</option>
          </select>
        </label>
      </div>
      <div class="card-body">
        @if (usage(); as u) {
          <div class="stats">
            @for (s of stats(); track s.label) {
              <div class="stat"><div class="stat-value">{{ s.value }}</div><div class="stat-label">{{ s.label }}</div></div>
            }
          </div>
        } @else if (error()) {
          <p class="field-error">{{ error() }}</p>
        } @else {
          <p class="muted">Loading…</p>
        }
      </div>
    </section>
  `,
})
export class UsageSection implements OnInit {
  private readonly api = inject(WorkspacesApi);
  private readonly ctx = inject(WorkspaceContext);
  protected readonly days = signal(30);
  protected readonly usage = signal<UsageOut | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly stats = computed(() => {
    const u = this.usage();
    if (!u) return [];
    const n = formatNumber;
    return [
      { label: 'Questions', value: n(u.questions) },
      { label: 'Answered', value: n(u.answered) },
      { label: 'No evidence', value: n(u.no_evidence) },
      { label: 'Refused', value: n(u.refused) },
      { label: 'Input tokens', value: n(u.input_tokens) },
      { label: 'Output tokens', value: n(u.output_tokens) },
      { label: 'Cached input tokens', value: n(u.cache_read_input_tokens) },
      { label: 'Documents', value: n(u.documents) },
      { label: 'Chunks', value: n(u.chunks) },
    ];
  });

  ngOnInit(): void {
    void this.load();
  }

  protected setDays(e: Event): void {
    this.days.set(Number(inputValue(e)));
    void this.load();
  }

  private async load(): Promise<void> {
    this.error.set(null);
    try {
      this.usage.set(await firstValueFrom(this.api.usage(this.ctx.require(), this.days())));
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    }
  }
}
