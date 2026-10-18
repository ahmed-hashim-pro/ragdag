import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { CollectionsApi } from '../../api/collections.service';
import { apiErrorMessage } from '../../api/errors';
import { CollectionOut, DAG_IDS, RUN_STATES, RunPage, TERMINAL_RUN_STATES } from '../../api/models';
import { PipelinesApi } from '../../api/pipelines.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { EmptyState } from '../../shared/empty-state';
import { durationBetween, formatDate, inputValue, relativeTime } from '../../shared/format';
import { Pager } from '../../shared/pager';

const PAGE_SIZE = 25;
const POLL_MS = 5000;

export function dagLabel(dagId: string): string {
  return dagId.replace(/^ragdag_/, '').replace(/_/g, ' ');
}

@Component({
  selector: 'app-runs-page',
  imports: [RouterLink, Badge, Pager, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-head">
        <div class="page-title">
          <h1>Pipelines</h1>
          <p>Airflow runs that ingest documents, sync sources, and re-index collections.</p>
        </div>
      </div>

      <section class="card">
        <div class="card-head">
          <label class="row gap-sm">
            <span class="small muted">Pipeline</span>
            <select class="select input-sm" style="width: auto" [value]="dagFilter()" (change)="setDag($event)">
              <option value="">All pipelines</option>
              @for (d of dags; track d) {<option [value]="d">{{ label(d) }}</option>}
            </select>
          </label>
          <label class="row gap-sm">
            <span class="small muted">State</span>
            <select class="select input-sm" style="width: auto" [value]="stateFilter()" (change)="setState($event)">
              <option value="">Any state</option>
              @for (s of states; track s) {<option [value]="s">{{ s }}</option>}
            </select>
          </label>
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm" (click)="load(false)">Refresh</button>
        </div>

        @if (error()) {<p class="card-body field-error" role="alert">{{ error() }}</p>}
        @if (page(); as p) {
          @if (p.items.length) {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">Pipeline</th><th scope="col">State</th><th scope="col">Related</th>
                    <th scope="col">Started</th><th scope="col">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of p.items; track r.id) {
                    <tr>
                      <td>
                        <a class="cell-title" [routerLink]="[r.id]">{{ label(r.dag_id) }}</a>
                        <div class="subtle mono truncate" style="max-width: 280px" [title]="r.dag_run_id">{{ r.dag_run_id }}</div>
                      </td>
                      <td>
                        <app-badge [value]="r.state" [dot]="true" />
                        @if (r.error) {<div class="small field-error truncate" style="max-width: 240px" [title]="r.error">{{ r.error }}</div>}
                      </td>
                      <td class="small">
                        @if (r.collection_id) {
                          <a [routerLink]="['/w', ctx.wsId(), 'collections', r.collection_id]">{{ collectionName(r.collection_id) }}</a>
                        }
                        @if (r.collection_id && r.document_id) {
                          <div><a [routerLink]="['/w', ctx.wsId(), 'collections', r.collection_id, 'documents']" [queryParams]="{ doc: r.document_id }">Document</a></div>
                        }
                        @if (!r.collection_id) {<span class="subtle">—</span>}
                      </td>
                      <td class="nowrap muted" [title]="fmt(r.started_at ?? r.created_at)">{{ rel(r.started_at ?? r.created_at) }}</td>
                      <td class="nowrap muted">{{ dur(r.started_at, r.ended_at) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <app-pager [total]="p.total" [offset]="offset()" [limit]="limit" (offsetChange)="offset.set($event)" />
          } @else {
            <app-empty-state heading="No pipeline runs" icon="⇢"
              [message]="dagFilter() || stateFilter() ? 'No runs match these filters.' : 'Runs appear here when documents are uploaded, sources sync, or a collection is re-indexed.'" />
          }
        } @else if (!error()) {
          <p class="card-body muted" role="status">Loading runs…</p>
        }
      </section>
    </div>
  `,
})
export class RunsPage implements OnDestroy {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly api = inject(PipelinesApi);
  private readonly collectionsApi = inject(CollectionsApi);
  private readonly router = inject(Router);

  /** Query params: ?dag=…&state=… */
  readonly dag = input<string | undefined>();
  readonly state = input<string | undefined>();

  protected readonly dags = DAG_IDS;
  protected readonly states = RUN_STATES;
  protected readonly limit = PAGE_SIZE;
  protected readonly label = dagLabel;
  protected readonly fmt = formatDate;
  protected readonly rel = relativeTime;
  protected readonly dur = durationBetween;

  protected readonly dagFilter = computed(() => this.dag() ?? '');
  protected readonly stateFilter = computed(() => this.state() ?? '');
  protected readonly offset = signal(0);
  protected readonly page = signal<RunPage | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly collections = signal<CollectionOut[]>([]);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    effect(() => {
      this.dagFilter();
      this.stateFilter();
      this.offset();
      untracked(() => void this.load(false));
    });
    firstValueFrom(this.collectionsApi.list(this.ctx.require()))
      .then((c) => this.collections.set(c))
      .catch(() => undefined);
  }

  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  protected collectionName(id: string): string {
    return this.collections().find((c) => c.id === id)?.name ?? 'Collection';
  }

  protected setDag(e: Event): void {
    this.offset.set(0);
    void this.router.navigate([], { queryParams: { dag: inputValue(e) || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected setState(e: Event): void {
    this.offset.set(0);
    void this.router.navigate([], { queryParams: { state: inputValue(e) || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected async load(background: boolean): Promise<void> {
    const seq = ++this.seq;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      const page = await firstValueFrom(
        this.api.runs(
          this.ctx.require(),
          { dag_id: this.dagFilter(), state: this.stateFilter(), offset: this.offset(), limit: PAGE_SIZE },
          background,
        ),
      );
      if (seq !== this.seq) return;
      this.page.set(page);
      this.error.set(null);
    } catch (e) {
      if (seq !== this.seq) return;
      if (!background) this.error.set(apiErrorMessage(e));
    }
    // Keep the list fresh while anything on this page is still running.
    if (!this.destroyed && seq === this.seq && (this.page()?.items ?? []).some((r) => !TERMINAL_RUN_STATES.has(r.state))) {
      this.timer = setTimeout(() => void this.load(true), POLL_MS);
    }
  }
}
