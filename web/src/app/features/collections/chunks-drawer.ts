import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { DocumentsApi } from '../../api/documents.service';
import { apiErrorMessage } from '../../api/errors';
import { ChunkOut, DocumentOut } from '../../api/models';
import { Badge } from '../../shared/badge';
import { Drawer } from '../../shared/drawer';
import { formatBytes, formatDate, formatNumber } from '../../shared/format';

/** Drawer listing a document's indexed chunks (heading path, token count, content). */
@Component({
  selector: 'app-chunks-drawer',
  imports: [Drawer, Badge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-drawer [open]="!!documentId()" [heading]="doc()?.title ?? 'Document'" [wide]="true" (closed)="closed.emit()">
      @if (doc(); as d) {
        <div class="stack" style="margin-bottom: 16px">
          <div class="row row-wrap small">
            <app-badge [value]="d.status" [dot]="true" />
            <span class="muted">{{ d.filename }}</span>
            <span class="muted">· {{ size(d.size_bytes) }}</span>
            <span class="muted">· {{ n(d.chunk_count) }} chunks · {{ n(d.token_count) }} tokens</span>
            @if (d.indexed_at) {<span class="muted">· indexed {{ date(d.indexed_at) }}</span>}
          </div>
          @if (d.error) {<p class="callout" data-tone="danger">{{ d.error }}</p>}
        </div>
      }
      @if (error()) {
        <p class="field-error" role="alert">{{ error() }}</p>
      } @else if (chunks(); as list) {
        <ol class="stack" style="list-style: none; padding: 0; margin: 0">
          @for (c of list; track c.id) {
            <li class="card" style="padding: 12px 14px">
              <div class="row small" style="margin-bottom: 6px">
                <strong>#{{ c.ordinal + 1 }}</strong>
                <span class="muted truncate" style="flex: 1">{{ c.heading || '(no heading)' }}</span>
                <span class="subtle nowrap">{{ c.token_count }} tokens</span>
              </div>
              <pre class="mono" style="white-space: pre-wrap; margin: 0; font-size: 0.82rem; overflow-wrap: anywhere">{{ c.content }}</pre>
            </li>
          } @empty {
            <li class="muted">No chunks yet — the document has not been indexed.</li>
          }
        </ol>
      } @else {
        <p class="muted" role="status">Loading chunks…</p>
      }
    </app-drawer>
  `,
})
export class ChunksDrawer {
  private readonly api = inject(DocumentsApi);
  readonly wsId = input.required<string>();
  readonly documentId = input<string | null>(null);
  /** Optional already-loaded row (avoids a round-trip for the header). */
  readonly document = input<DocumentOut | null>(null);
  readonly closed = output<void>();

  protected readonly doc = signal<DocumentOut | null>(null);
  protected readonly chunks = signal<ChunkOut[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly size = formatBytes;
  protected readonly date = formatDate;
  protected readonly n = formatNumber;

  constructor() {
    effect(() => {
      const id = this.documentId();
      const known = this.document();
      untracked(() => void this.load(id, known));
    });
  }

  private async load(id: string | null, known: DocumentOut | null): Promise<void> {
    this.chunks.set(null);
    this.error.set(null);
    this.doc.set(known && known.id === id ? known : null);
    if (!id) return;
    try {
      const [doc, chunks] = await Promise.all([
        this.doc() ? Promise.resolve(this.doc()!) : firstValueFrom(this.api.get(this.wsId(), id)),
        firstValueFrom(this.api.chunks(this.wsId(), id)),
      ]);
      if (this.documentId() !== id) return;
      this.doc.set(doc);
      this.chunks.set(chunks);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    }
  }
}
