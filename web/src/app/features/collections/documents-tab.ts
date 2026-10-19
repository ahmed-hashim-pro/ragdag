import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { DocumentsApi } from '../../api/documents.service';
import { apiErrorMessage } from '../../api/errors';
import { DOCUMENT_STATUSES, DocumentOut } from '../../api/models';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { ConfirmService } from '../../shared/confirm';
import { EmptyState } from '../../shared/empty-state';
import { formatBytes, formatNumber, inputValue, relativeTime } from '../../shared/format';
import { Pager } from '../../shared/pager';
import { ChunksDrawer } from './chunks-drawer';
import { CollectionStore } from './collection-store';
import { UploadPanel } from './upload-panel';

const PAGE_SIZE = 25;
const POLL_MS = 3000;

@Component({
  selector: 'app-documents-tab',
  imports: [Badge, Pager, EmptyState, UploadPanel, ChunksDrawer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack-lg">
      @if (ctx.canEdit()) {
        <app-upload-panel [wsId]="store.wsId" [collectionId]="store.collectionId" (uploaded)="onUploaded()" />
      }

      <section class="card" aria-labelledby="docs-h">
        <div class="card-head">
          <h2 id="docs-h">Documents</h2>
          <label class="field" style="flex: 1 1 200px; max-width: 320px">
            <span class="sr-only">Search documents</span>
            <input class="input input-sm" type="search" placeholder="Search title or filename…" [value]="q()" (input)="onSearch($event)" />
          </label>
          <label>
            <span class="sr-only">Status</span>
            <select class="select input-sm" style="width: auto" [value]="status()" (change)="onStatus($event)">
              <option value="">All statuses</option>
              @for (s of statuses; track s) {<option [value]="s">{{ s }}</option>}
            </select>
          </label>
        </div>

        @if (error()) {
          <p class="card-body field-error" role="alert">{{ error() }}</p>
        }
        @if (page(); as p) {
          @if (p.items.length) {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Size</th>
                    <th scope="col">Status</th>
                    <th scope="col" class="right">Chunks</th>
                    <th scope="col">Updated</th>
                    <th scope="col"><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (d of p.items; track d.id) {
                    <tr>
                      <td>
                        <button type="button" class="link-btn cell-title truncate" style="display: block; text-align: left; max-width: 340px"
                          (click)="openChunks(d)" [title]="'View chunks of ' + d.title" dir="auto">{{ d.title }}</button>
                        <div class="subtle truncate" style="max-width: 340px">{{ d.filename }}</div>
                      </td>
                      <td class="nowrap muted">{{ size(d.size_bytes) }}</td>
                      <td>
                        <app-badge [value]="d.status" [dot]="true" />
                        @if (d.error) {<div class="small field-error truncate" style="max-width: 220px" [title]="d.error">{{ d.error }}</div>}
                      </td>
                      <td class="right">{{ n(d.chunk_count) }}</td>
                      <td class="nowrap muted" [title]="d.updated_at">{{ rel(d.updated_at) }}</td>
                      <td class="actions">
                        <button type="button" class="btn btn-sm btn-ghost" (click)="openChunks(d)">Chunks</button>
                        @if (ctx.canEdit()) {
                          <button type="button" class="btn btn-sm btn-ghost" (click)="reingest(d)" [disabled]="busyId() === d.id">Re-ingest</button>
                          <button type="button" class="btn btn-sm btn-ghost btn-danger-ghost" (click)="remove(d)" [disabled]="busyId() === d.id">Delete</button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <app-pager [total]="p.total" [offset]="offset()" [limit]="limit" (offsetChange)="setOffset($event)" />
          } @else if (q() || status()) {
            <app-empty-state heading="No matching documents" message="Try a different search or status filter." icon="⌕">
              <button type="button" class="btn" (click)="clearFilters()">Clear filters</button>
            </app-empty-state>
          } @else {
            <app-empty-state heading="No documents yet" icon="▤"
              [message]="ctx.canEdit()
                ? 'Upload Markdown, text, PDF or HTML files above, or add a URL / folder source. Each file is extracted, chunked and embedded by an Airflow pipeline.'
                : 'Editors can upload documents to this collection.'" />
          }
        } @else if (!error()) {
          <p class="card-body muted" role="status">Loading documents…</p>
        }
        @if (polling()) {
          <p class="card-body subtle" style="border-top: 1px solid var(--border)" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span> Ingesting — this list refreshes automatically.
          </p>
        }
      </section>
    </div>

    <app-chunks-drawer [wsId]="store.wsId" [documentId]="openDocId()" [document]="openDoc()" (closed)="closeChunks()" />
  `,
})
export class DocumentsTab implements OnDestroy {
  protected readonly ctx = inject(WorkspaceContext);
  protected readonly store = inject(CollectionStore);
  private readonly api = inject(DocumentsApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);

  /** `?doc=<id>` opens that document's chunks (used by links from pipeline runs). */
  readonly doc = input<string | undefined>();

  protected readonly statuses = DOCUMENT_STATUSES;
  protected readonly limit = PAGE_SIZE;
  protected readonly size = formatBytes;
  protected readonly rel = relativeTime;
  protected readonly n = formatNumber;

  protected readonly q = signal('');
  protected readonly status = signal('');
  protected readonly offset = signal(0);
  protected readonly page = signal<{ items: DocumentOut[]; total: number } | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busyId = signal<string | null>(null);
  protected readonly openDocId = signal<string | null>(null);
  protected readonly openDoc = signal<DocumentOut | null>(null);

  protected readonly polling = computed(() =>
    (this.page()?.items ?? []).some((d) => d.status === 'pending' || d.status === 'processing'),
  );

  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor() {
    effect(() => {
      // Reload whenever the filters or page change.
      this.q();
      this.status();
      this.offset();
      untracked(() => void this.load(false));
    });
    effect(() => {
      const id = this.doc();
      if (id) untracked(() => this.openDocId.set(id));
    });
  }

  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.searchTimer = this.pollTimer = null;
  }

  private async load(background: boolean): Promise<void> {
    const seq = ++this.seq;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    try {
      const page = await firstValueFrom(
        this.api.list(
          this.store.wsId,
          this.store.collectionId,
          { q: this.q().trim(), status_filter: this.status(), offset: this.offset(), limit: PAGE_SIZE },
          background,
        ),
      );
      if (seq !== this.seq) return;
      const wasPolling = this.polling();
      this.page.set(page);
      this.error.set(null);
      if (wasPolling && !this.polling()) void this.store.refresh();
    } catch (e) {
      if (seq !== this.seq) return;
      if (!background) this.error.set(apiErrorMessage(e));
    }
    if (seq === this.seq && this.polling() && !this.destroyed) {
      this.pollTimer = setTimeout(() => void this.load(true), POLL_MS);
    }
  }

  protected onSearch(e: Event): void {
    const value = inputValue(e);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.offset.set(0);
      this.q.set(value);
    }, 300);
  }

  protected onStatus(e: Event): void {
    this.offset.set(0);
    this.status.set(inputValue(e));
  }

  protected setOffset(offset: number): void {
    this.offset.set(offset);
  }

  protected clearFilters(): void {
    this.offset.set(0);
    this.q.set('');
    this.status.set('');
  }

  protected onUploaded(): void {
    void this.load(true);
    void this.store.refresh();
  }

  protected openChunks(d: DocumentOut): void {
    this.openDoc.set(d);
    this.openDocId.set(d.id);
  }

  protected closeChunks(): void {
    this.openDocId.set(null);
    this.openDoc.set(null);
    if (this.doc()) void this.router.navigate([], { queryParams: { doc: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected async reingest(d: DocumentOut): Promise<void> {
    this.busyId.set(d.id);
    try {
      await firstValueFrom(this.api.reingest(this.store.wsId, d.id));
      this.toast.success(`Re-ingesting “${d.title}”.`);
      await this.load(true);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busyId.set(null);
    }
  }

  protected async remove(d: DocumentOut): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete document?',
      message: `“${d.title}” and its ${d.chunk_count} chunks will be removed from the collection.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    this.busyId.set(d.id);
    try {
      await firstValueFrom(this.api.delete(this.store.wsId, d.id));
      this.toast.success('Document deleted.');
      const p = this.page();
      if (p && p.items.length === 1 && this.offset() > 0) this.offset.set(Math.max(0, this.offset() - PAGE_SIZE));
      else await this.load(true);
      void this.store.refresh();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busyId.set(null);
    }
  }
}
