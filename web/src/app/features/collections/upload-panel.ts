import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, input, output, signal } from '@angular/core';
import { Subscription } from 'rxjs';

import { DocumentsApi, UPLOAD_EXTENSIONS, isUploadable } from '../../api/documents.service';
import { AuthService } from '../../core/auth/auth.service';
import { apiErrorMessage } from '../../api/errors';
import { UploadResult } from '../../api/models';
import { formatBytes } from '../../shared/format';

type UploadState = 'queued' | 'uploading' | 'done' | 'duplicate' | 'error';

interface UploadItem {
  id: number;
  file: File;
  state: UploadState;
  progress: number;
  message: string;
}

const CONCURRENCY = 2;

/** Drag-and-drop / file-picker multi-upload with per-file progress. */
@Component({
  selector: 'app-upload-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './upload-panel.css',
  template: `
    <div class="drop" [class.drop-active]="dragging()"
      (dragenter)="onDrag($event, true)" (dragover)="onDrag($event, true)" (dragleave)="onDrag($event, false)" (drop)="onDrop($event)">
      <span class="drop-icon" aria-hidden="true">⇪</span>
      <p><strong>Drop files here</strong> or
        <label class="link-btn">browse<input class="sr-only" type="file" multiple [accept]="accept" (change)="onPick($event)" /></label>
      </p>
      <p class="subtle">{{ accept.split(',').join(' ') }}@if (maxMb()) {<span> · up to {{ maxMb() }} MB each</span>}</p>
    </div>

    @if (items().length) {
      <div class="uploads">
        <div class="row small">
          <span class="muted" aria-live="polite">{{ summary() }}</span>
          <span class="spacer"></span>
          @if (finishedCount()) {<button type="button" class="btn btn-sm btn-ghost" (click)="clearFinished()">Clear finished</button>}
        </div>
        <ul class="upload-list" role="list">
          @for (it of items(); track it.id) {
            <li class="upload" [attr.data-state]="it.state">
              <div class="row gap-sm">
                <span class="truncate upload-name" [title]="it.file.name">{{ it.file.name }}</span>
                <span class="subtle nowrap">{{ size(it.file.size) }}</span>
                <span class="spacer"></span>
                <span class="small nowrap upload-status">{{ label(it) }}</span>
                @if (it.state === 'uploading' || it.state === 'queued') {
                  <button type="button" class="btn btn-ghost btn-icon btn-sm" [attr.aria-label]="'Cancel ' + it.file.name" (click)="cancel(it.id)">✕</button>
                }
              </div>
              @if (it.state === 'uploading' || it.state === 'queued') {
                <progress class="bar" max="100" [value]="it.progress" [attr.aria-label]="'Uploading ' + it.file.name"></progress>
              }
              @if (it.message) {<p class="small upload-msg">{{ it.message }}</p>}
            </li>
          }
        </ul>
      </div>
    }
  `,
})
export class UploadPanel implements OnDestroy {
  private readonly api = inject(DocumentsApi);
  private readonly auth = inject(AuthService);
  readonly wsId = input.required<string>();
  readonly collectionId = input.required<string>();
  readonly uploaded = output<UploadResult>();

  protected readonly accept = UPLOAD_EXTENSIONS.join(',');
  /** Server upload limit in bytes, known after the bootstrap call (null until then). */
  private readonly maxBytes = signal<number | null>(null);
  protected readonly maxMb = computed(() => {
    const max = this.maxBytes();
    return max === null ? null : Math.round(max / 1024 / 1024);
  });

  constructor() {
    this.auth.bootstrap().subscribe({
      next: (b) => this.maxBytes.set(b.max_upload_mb * 1024 * 1024),
      error: () => {}, // the server still enforces the limit (413)
    });
  }
  protected readonly size = formatBytes;
  protected readonly dragging = signal(false);
  protected readonly items = signal<UploadItem[]>([]);
  private readonly subs = new Map<number, Subscription>();
  private seq = 0;

  protected readonly finishedCount = computed(
    () => this.items().filter((i) => i.state === 'done' || i.state === 'duplicate' || i.state === 'error').length,
  );
  protected readonly summary = computed(() => {
    const list = this.items();
    const active = list.filter((i) => i.state === 'uploading' || i.state === 'queued').length;
    const failed = list.filter((i) => i.state === 'error').length;
    if (active) return `Uploading ${active} file${active === 1 ? '' : 's'}…`;
    return `${list.length - failed} uploaded${failed ? `, ${failed} failed` : ''}.`;
  });

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  protected onDrag(event: DragEvent, over: boolean): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dragging.set(over);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.add(Array.from(event.dataTransfer?.files ?? []));
  }

  protected onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.add(Array.from(input.files ?? []));
    input.value = '';
  }

  protected label(it: UploadItem): string {
    switch (it.state) {
      case 'queued':
        return 'Waiting…';
      case 'uploading':
        return `${it.progress}%`;
      case 'done':
        return 'Uploaded ✓';
      case 'duplicate':
        return 'Already uploaded';
      case 'error':
        return 'Failed';
    }
  }

  protected clearFinished(): void {
    this.items.update((list) => list.filter((i) => i.state === 'uploading' || i.state === 'queued'));
  }

  protected cancel(id: number): void {
    this.subs.get(id)?.unsubscribe();
    this.subs.delete(id);
    this.patch(id, { state: 'error', message: 'Cancelled.' });
    this.pump();
  }

  private add(files: File[]): void {
    const fresh: UploadItem[] = files.map((file) => {
      const max = this.maxBytes();
      const message = !isUploadable(file.name)
        ? `Unsupported file type. Allowed: ${UPLOAD_EXTENSIONS.join(', ')}`
        : max !== null && file.size > max
          ? `Larger than the ${this.maxMb()} MB upload limit.`
          : '';
      return { id: ++this.seq, file, state: message ? 'error' : 'queued', progress: 0, message };
    });
    this.items.update((list) => [...list, ...fresh]);
    this.pump();
  }

  private patch(id: number, changes: Partial<UploadItem>): void {
    this.items.update((list) => list.map((i) => (i.id === id ? { ...i, ...changes } : i)));
  }

  /** Start queued uploads up to the concurrency limit. */
  private pump(): void {
    const active = this.items().filter((i) => i.state === 'uploading').length;
    const next = this.items().filter((i) => i.state === 'queued').slice(0, Math.max(0, CONCURRENCY - active));
    for (const it of next) this.start(it);
  }

  private start(it: UploadItem): void {
    this.patch(it.id, { state: 'uploading', progress: 0 });
    const sub = this.api.upload(this.wsId(), this.collectionId(), it.file).subscribe({
      next: (ev) => {
        if (ev.type === HttpEventType.UploadProgress) {
          const pct = ev.total ? Math.round((ev.loaded / ev.total) * 100) : 0;
          this.patch(it.id, { progress: Math.min(99, pct) });
        } else if (ev.type === HttpEventType.Response && ev.body) {
          const dup = !!ev.body.duplicate;
          this.patch(it.id, {
            state: dup ? 'duplicate' : 'done',
            progress: 100,
            message: dup ? `Identical content already exists as “${ev.body.document.title}”.` : '',
          });
          this.uploaded.emit(ev.body);
        }
      },
      error: (err: unknown) => {
        this.subs.delete(it.id);
        const message = err instanceof HttpErrorResponse && err.status === 413 ? 'The file is too large for the server.' : apiErrorMessage(err);
        this.patch(it.id, { state: 'error', message });
        this.pump();
      },
      complete: () => {
        this.subs.delete(it.id);
        this.pump();
      },
    });
    this.subs.set(it.id, sub);
  }
}
