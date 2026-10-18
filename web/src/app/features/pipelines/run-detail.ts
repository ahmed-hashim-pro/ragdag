import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { RunDetailOut, TERMINAL_RUN_STATES, TaskNode } from '../../api/models';
import { PipelinesApi } from '../../api/pipelines.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { durationBetween, formatDate, formatDuration } from '../../shared/format';
import { DagGraph } from './dag-graph';
import { dagLabel } from './runs-page';
import { TaskLogDrawer } from './task-log-drawer';

const POLL_MS = 2000;

@Component({
  selector: 'app-run-detail',
  imports: [RouterLink, Badge, DagGraph, TaskLogDrawer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <nav class="subtle" aria-label="Breadcrumb" style="margin-bottom: 8px">
        <a [routerLink]="['/w', ctx.wsId(), 'pipelines']">Pipelines</a> ›
      </nav>
      @if (detail(); as d) {
        <div class="page-head">
          <div class="page-title">
            <h1>{{ label(d.run.dag_id) }}</h1>
            <p class="mono small">{{ d.run.dag_run_id }}</p>
          </div>
          @if (d.airflow_ui_url) {
            <a class="btn" [href]="d.airflow_ui_url" target="_blank" rel="noopener noreferrer">Open in Airflow ↗</a>
          }
        </div>

        <div class="stack-lg">
          <section class="card card-pad">
            <dl class="form-grid" style="margin: 0">
              <div><dt class="label">State</dt><dd class="row gap-sm" style="margin: 4px 0 0">
                <app-badge [value]="d.run.state" [dot]="true" />
                @if (!terminal()) {<span class="subtle" aria-live="polite">live</span>}
              </dd></div>
              <div><dt class="label">Started</dt><dd class="muted" style="margin: 4px 0 0">{{ fmt(d.run.started_at ?? d.run.created_at) }}</dd></div>
              <div><dt class="label">Duration</dt><dd class="muted" style="margin: 4px 0 0">{{ dur(d.run.started_at, d.run.ended_at) || '—' }}</dd></div>
              <div><dt class="label">Related</dt><dd style="margin: 4px 0 0">
                @if (d.run.collection_id) {
                  <a [routerLink]="['/w', ctx.wsId(), 'collections', d.run.collection_id]">Collection</a>
                  @if (d.run.document_id) {
                    · <a [routerLink]="['/w', ctx.wsId(), 'collections', d.run.collection_id, 'documents']" [queryParams]="{ doc: d.run.document_id }">Document</a>
                  }
                } @else {<span class="muted">—</span>}
              </dd></div>
            </dl>
            @if (d.run.error) {<p class="callout" data-tone="danger" style="margin-top: 14px">{{ d.run.error }}</p>}
          </section>

          <section class="card" aria-labelledby="graph-h">
            <div class="card-head">
              <h2 id="graph-h">Tasks</h2>
              @if (ctx.canEdit() && d.tasks.length) {<span class="subtle">Select a task to read its log.</span>}
            </div>
            <div class="card-body">
              @if (d.tasks.length) {
                <app-dag-graph [tasks]="d.tasks" [clickable]="ctx.canEdit()" [selected]="logTask()?.task_id ?? null" (taskClick)="openLog($event)" />
                <ul class="legend" aria-label="Legend">
                  @for (s of legend; track s) {<li><app-badge [value]="s" [dot]="true" /></li>}
                </ul>
              } @else {
                <p class="muted">Task details are unavailable — Airflow could not be reached{{ d.airflow_state ? '' : ' or the run has not started' }}.</p>
              }
            </div>
            @if (d.tasks.length) {
              <div class="table-wrap">
                <table class="table">
                  <caption class="sr-only">Task instances</caption>
                  <thead><tr><th scope="col">Task</th><th scope="col">State</th><th scope="col">Try</th><th scope="col">Mapped</th><th scope="col">Duration</th><th scope="col"><span class="sr-only">Log</span></th></tr></thead>
                  <tbody>
                    @for (t of d.tasks; track t.task_id) {
                      <tr>
                        <td class="mono">{{ t.task_id }}</td>
                        <td><app-badge [value]="t.state ?? 'none'" [dot]="true" /></td>
                        <td>{{ t.try_number ?? '—' }}</td>
                        <td>{{ t.mapped_count ? '×' + t.mapped_count : '—' }}</td>
                        <td class="muted">{{ duration(t.duration) || '—' }}</td>
                        <td class="actions">
                          @if (ctx.canEdit()) {<button type="button" class="btn btn-sm btn-ghost" (click)="openLog(t)">Log</button>}
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        </div>
        <app-task-log-drawer [wsId]="ctx.require()" [runId]="runId()" [task]="logTask()" (closed)="logTask.set(null)" />
      } @else if (error()) {
        <p class="callout" data-tone="danger" role="alert">{{ error() }}</p>
      } @else {
        <p class="muted" role="status">Loading run…</p>
      }
    </div>
  `,
  styles: `
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      list-style: none;
      padding: 0;
      margin: 12px 0 0;
      justify-content: center;
    }
  `,
})
export class RunDetailPage implements OnDestroy {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly api = inject(PipelinesApi);
  readonly runId = input.required<string>();

  protected readonly label = dagLabel;
  protected readonly fmt = formatDate;
  protected readonly dur = durationBetween;
  protected readonly duration = formatDuration;
  protected readonly legend = ['success', 'running', 'queued', 'scheduled', 'failed', 'upstream_failed', 'skipped', 'none'];

  protected readonly detail = signal<RunDetailOut | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly logTask = signal<TaskNode | null>(null);
  protected readonly terminal = computed(() => {
    const d = this.detail();
    return !!d && TERMINAL_RUN_STATES.has(d.run.state);
  });
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      const id = this.runId();
      untracked(() => {
        this.detail.set(null);
        void this.load(id, false);
      });
    });
  }

  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  protected openLog(t: TaskNode): void {
    if (this.ctx.canEdit()) this.logTask.set(t);
  }

  private async load(id: string, background: boolean): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const d = await firstValueFrom(this.api.run(this.ctx.require(), id, background));
      if (id !== this.runId()) return;
      this.detail.set(d);
      this.error.set(null);
    } catch (e) {
      if (!background) this.error.set(apiErrorMessage(e));
    }
    if (!this.destroyed && id === this.runId() && this.detail() && !this.terminal()) {
      this.timer = setTimeout(() => void this.load(id, true), POLL_MS);
    }
  }
}
