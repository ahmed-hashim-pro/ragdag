import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { CollectionsApi } from '../../api/collections.service';
import { apiErrorMessage } from '../../api/errors';
import { CollectionSettings, DEFAULT_COLLECTION_SETTINGS, EFFORTS, Effort } from '../../api/models';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { ConfirmService } from '../../shared/confirm';
import { CollectionStore } from './collection-store';

function overlapBelowChunk(group: AbstractControl): ValidationErrors | null {
  const tokens = Number(group.get('chunk_tokens')?.value);
  const overlap = Number(group.get('chunk_overlap')?.value);
  return overlap >= tokens ? { overlap: true } : null;
}

@Component({
  selector: 'app-collection-settings-tab',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="stack-lg" [formGroup]="form" (ngSubmit)="save()" novalidate>
      <section class="card" aria-labelledby="cs-general">
        <div class="card-head"><h2 id="cs-general">General</h2></div>
        <div class="card-body stack">
          <label class="field">
            <span class="label">Name</span>
            <input class="input" formControlName="name" maxlength="120" />
          </label>
          <label class="field">
            <span class="label">Description</span>
            <textarea class="textarea" formControlName="description" rows="3" maxlength="2000"></textarea>
          </label>
        </div>
      </section>

      <section class="card" aria-labelledby="cs-retrieval">
        <div class="card-head"><h2 id="cs-retrieval">Chunking & retrieval</h2></div>
        <div class="card-body stack" formGroupName="settings">
          <div class="form-grid">
            <label class="field">
              <span class="label">Chunk size (tokens)</span>
              <input class="input" type="number" formControlName="chunk_tokens" min="100" max="2000" step="10"
                [attr.aria-invalid]="settings.controls.chunk_tokens.invalid" />
              <span class="hint">100–2000. Smaller chunks are more precise; larger ones carry more context.</span>
            </label>
            <label class="field">
              <span class="label">Chunk overlap (tokens)</span>
              <input class="input" type="number" formControlName="chunk_overlap" min="0" max="500" step="5"
                [attr.aria-invalid]="settings.invalid && settings.hasError('overlap')" />
              <span class="hint" [class.field-error]="settings.hasError('overlap')">Must be smaller than the chunk size (max 500).</span>
            </label>
            <label class="field">
              <span class="label">Chunks per answer (top k)</span>
              <input class="input" type="number" formControlName="top_k" min="1" max="30" />
              <span class="hint">1–30 retrieved chunks are given to the model.</span>
            </label>
            <label class="field">
              <span class="label">Similarity floor</span>
              <input class="input" type="number" formControlName="similarity_floor" min="0" max="1" step="0.01" />
              <span class="hint">0–1. Below this best similarity the question is refused without calling the model.</span>
            </label>
            <label class="field">
              <span class="label">Model effort</span>
              <select class="select" formControlName="effort">
                @for (e of efforts; track e) {<option [value]="e">{{ e }}</option>}
              </select>
              <span class="hint">Higher effort: more thorough answers, more tokens and latency.</span>
            </label>
          </div>
          <div class="stack" style="gap: 10px">
            <label class="row gap-sm" style="align-items: flex-start">
              <input type="checkbox" formControlName="rewrite_queries" style="margin-top: 3px" />
              <span><strong>Understand questions first</strong>
                <span class="hint" style="display: block">Claude Haiku rewrites each question (typos, follow-ups like “and the second one?”,
                  questions about the whole collection) before searching. Adds well under a cent per question.</span></span>
            </label>
            <label class="row gap-sm" style="align-items: flex-start">
              <input type="checkbox" formControlName="rerank" style="margin-top: 3px" />
              <span><strong>Re-rank search results</strong>
                <span class="hint" style="display: block">A local model re-scores the top 30 matches for relevance before the best are sent.
                  Free; adds a fraction of a second.</span></span>
            </label>
          </div>
          @if (chunkingChanged()) {
            <p class="callout" data-tone="warning" role="status">
              Changing chunk size or overlap re-indexes every document in this collection. Answers may be incomplete until the re-index
              pipeline finishes.
            </p>
          }
        </div>
      </section>

      @if (error()) {<p class="callout" data-tone="danger" role="alert">{{ error() }}</p>}
      @if (ctx.canEdit()) {
        <div class="form-actions">
          <button type="button" class="btn" (click)="reset()" [disabled]="form.pristine || busy()">Discard changes</button>
          <button type="submit" class="btn btn-primary" [disabled]="form.invalid || form.pristine || busy()">
            @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
            Save settings
          </button>
        </div>

        <section class="callout" data-tone="danger" aria-labelledby="cs-danger">
          <div class="callout-body row row-wrap">
            <div style="flex: 1; min-width: 220px">
              <h2 id="cs-danger" style="font-size: 1rem">Delete collection</h2>
              <p class="small muted">Removes the collection, its documents, chunks, sources and conversations.</p>
            </div>
            <button type="button" class="btn btn-danger" (click)="remove()">Delete collection</button>
          </div>
        </section>
      } @else {
        <p class="muted small">You have read-only access. Editors can change these settings.</p>
      }
    </form>
  `,
})
export class CollectionSettingsTab {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly store = inject(CollectionStore);
  private readonly api = inject(CollectionsApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);
  protected readonly efforts = EFFORTS;
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly fb = inject(FormBuilder).nonNullable;
  protected readonly settings = this.fb.group(
    {
      chunk_tokens: [400, [Validators.required, Validators.min(100), Validators.max(2000)]],
      chunk_overlap: [60, [Validators.required, Validators.min(0), Validators.max(500)]],
      top_k: [8, [Validators.required, Validators.min(1), Validators.max(30)]],
      similarity_floor: [0.35, [Validators.required, Validators.min(0), Validators.max(1)]],
      effort: ['medium' as Effort, Validators.required],
      rewrite_queries: [true],
      rerank: [true],
    },
    { validators: overlapBelowChunk },
  );
  protected readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    description: ['', Validators.maxLength(2000)],
    settings: this.settings,
  });

  private readonly value = toSignal(this.settings.valueChanges, { initialValue: this.settings.getRawValue() });
  protected readonly chunkingChanged = computed(() => {
    const current = this.store.collection()?.settings ?? DEFAULT_COLLECTION_SETTINGS;
    const v = this.value();
    return Number(v.chunk_tokens) !== current.chunk_tokens || Number(v.chunk_overlap) !== current.chunk_overlap;
  });

  constructor() {
    this.reset();
    if (!this.ctx.canEdit()) this.form.disable();
  }

  protected reset(): void {
    const c = this.store.collection();
    if (!c) return;
    this.form.reset({
      name: c.name,
      description: c.description,
      settings: { ...DEFAULT_COLLECTION_SETTINGS, ...c.settings },
    });
    this.error.set(null);
  }

  protected async save(): Promise<void> {
    const v = this.form.getRawValue();
    const settings: CollectionSettings = {
      chunk_tokens: Number(v.settings.chunk_tokens),
      chunk_overlap: Number(v.settings.chunk_overlap),
      top_k: Number(v.settings.top_k),
      similarity_floor: Number(v.settings.similarity_floor),
      effort: v.settings.effort,
      rewrite_queries: v.settings.rewrite_queries,
      rerank: v.settings.rerank,
    };
    const reindex = this.chunkingChanged();
    if (reindex) {
      const ok = await this.confirm.confirm({
        title: 'Re-index every document?',
        message: 'New chunk settings only apply after each document is chunked and embedded again. This runs as a pipeline.',
        confirmLabel: 'Save and re-index',
      });
      if (!ok) return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const updated = await firstValueFrom(
        this.api.update(this.ctx.require(), this.store.collectionId, {
          name: v.name.trim(),
          description: v.description,
          settings,
        }),
      );
      this.store.set(updated);
      this.reset();
      this.toast.success(reindex ? 'Settings saved; re-indexing started.' : 'Settings saved.');
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const c = this.store.collection();
    if (!c) return;
    const ok = await this.confirm.confirm({
      title: 'Delete collection?',
      message: `“${c.name}” and its ${c.document_count} documents, sources and conversations will be deleted.`,
      confirmLabel: 'Delete collection',
      danger: true,
      typeToConfirm: c.name,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.api.delete(this.ctx.require(), c.id));
      this.toast.success('Collection deleted.');
      await this.router.navigate(['/w', this.ctx.require(), 'collections']);
    } catch (e) {
      this.toast.error(e);
    }
  }
}
