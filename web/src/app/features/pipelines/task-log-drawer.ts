import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { TaskNode } from '../../api/models';
import { PipelinesApi } from '../../api/pipelines.service';
import { Drawer } from '../../shared/drawer';
import { inputValue } from '../../shared/format';

@Component({
  selector: 'app-task-log-drawer',
  imports: [Drawer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-drawer [open]="!!task()" [heading]="'Log · ' + (task()?.task_id ?? '')" [wide]="true" (closed)="closed.emit()">
      <div class="row row-wrap" style="margin-bottom: 12px">
        @if (tries().length > 1) {
          <label class="row gap-sm small">
            <span class="muted">Attempt</span>
            <select class="select input-sm" style="width: auto" [value]="tryNumber()" (change)="setTry($event)">
              @for (t of tries(); track t) {<option [value]="t">{{ t }}</option>}
            </select>
          </label>
        }
        <span class="spacer"></span>
        <button type="button" class="btn btn-sm" (click)="reload()" [disabled]="loading()">Reload</button>
      </div>
      @if (error()) {
        <p class="callout" data-tone="danger" role="alert">{{ error() }}</p>
      } @else if (loading() && !content()) {
        <p class="muted" role="status">Loading log…</p>
      } @else {
        <pre class="log" tabindex="0" aria-label="Task log">{{ content() || '(empty log)' }}</pre>
      }
    </app-drawer>
  `,
  styles: `
    .log {
      margin: 0;
      padding: 12px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      font-size: 0.78rem;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  `,
})
export class TaskLogDrawer {
  private readonly api = inject(PipelinesApi);
  readonly wsId = input.required<string>();
  readonly runId = input.required<string>();
  readonly task = input<TaskNode | null>(null);
  readonly closed = output<void>();

  protected readonly tryNumber = signal(1);
  protected readonly tries = signal<number[]>([1]);
  protected readonly content = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const t = this.task();
      untracked(() => {
        if (!t) return;
        const latest = Math.max(1, t.try_number ?? 1);
        this.tries.set(Array.from({ length: latest }, (_, i) => latest - i));
        this.tryNumber.set(latest);
        this.content.set('');
        void this.load();
      });
    });
  }

  protected setTry(e: Event): void {
    this.tryNumber.set(Number(inputValue(e)));
    void this.load();
  }

  protected reload(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const t = this.task();
    if (!t) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const log = await firstValueFrom(this.api.taskLog(this.wsId(), this.runId(), t.task_id, this.tryNumber()));
      if (this.task()?.task_id === t.task_id) this.content.set(log.content);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
