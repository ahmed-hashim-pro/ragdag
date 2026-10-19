import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

import { CollectionsApi } from '../../api/collections.service';
import { apiErrorMessage } from '../../api/errors';
import { SearchOut } from '../../api/models';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { EmptyState } from '../../shared/empty-state';
import { formatUsd } from '../../shared/format';
import { CollectionStore } from './collection-store';

/** Retrieval playground: see exactly what the model would be given for a question. */
@Component({
  selector: 'app-search-tab',
  imports: [ReactiveFormsModule, Badge, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack-lg">
      <form class="card card-pad stack" [formGroup]="form" (ngSubmit)="search()" role="search">
        <div class="row row-wrap" style="align-items: flex-end">
          <label class="field" style="flex: 1 1 260px">
            <span class="label">Query</span>
            <input class="input" type="search" formControlName="query" maxlength="2000" placeholder="Ask the way a user would…" dir="auto" />
          </label>
          <label class="field" style="width: 100px">
            <span class="label">Top k</span>
            <input class="input" type="number" formControlName="top_k" min="1" max="30" />
          </label>
          <label class="row gap-sm small" style="padding-bottom: 10px" title="Uses the workspace API key (Claude Haiku)">
            <input type="checkbox" formControlName="rewrite" /> Rewrite with Haiku
          </label>
          <button class="btn btn-primary" type="submit" [disabled]="form.invalid || busy()">
            @if (busy()) {<span class="spinner" aria-hidden="true"></span>}
            Search
          </button>
        </div>
        <p class="hint">
          Hybrid retrieval (vector + full-text, fused by reciprocal rank), then re-ranked by a local model when the collection has re-ranking on.
          “Rewrite with Haiku” shows how the question is understood before searching, as the Ask page does. Answers are refused locally when the best similarity is below the
          collection's floor ({{ floor() }}).
        </p>
      </form>

      @if (error()) {<p class="callout" data-tone="danger" role="alert">{{ error() }}</p>}

      @if (result(); as r) {
        @if (r.plan; as p) {
          <div class="card card-pad small stack" style="gap: 4px">
            <div><strong>Understood as:</strong> {{ p.intent === 'overview' ? 'a question about the whole collection' : p.intent === 'chitchat' ? 'small talk' : 'a lookup' }}</div>
            <div><strong>Searched for:</strong> “{{ p.query }}”</div>
            @if (p.keywords.length) {<div><strong>Exact terms:</strong> {{ p.keywords.join(', ') }}</div>}
            <div class="muted">Planning cost ≈ {{ usd(p.cost_usd) }}</div>
          </div>
        }
        <section aria-labelledby="hits-h" aria-live="polite">
          <div class="row row-wrap" style="margin-bottom: 12px">
            <h2 id="hits-h" style="flex: 1">{{ r.hits.length }} result{{ r.hits.length === 1 ? '' : 's' }}</h2>
            <span class="small muted">best similarity <strong>{{ r.best_similarity.toFixed(3) }}</strong></span>
            @if (r.confident) {
              <app-badge value="success" text="confident — would answer" [dot]="true" />
            } @else {
              <app-badge value="no_evidence" text="below floor — would refuse" [dot]="true" />
            }
          </div>
          @if (r.hits.length) {
            <ol class="stack" style="list-style: none; margin: 0; padding: 0">
              @for (h of r.hits; track h.chunk_id; let i = $index) {
                <li class="card card-pad stack" style="gap: 8px">
                  <div class="row row-wrap small">
                    <strong class="nowrap">#{{ i + 1 }}</strong>
                    <span class="cell-title truncate" style="flex: 1" dir="auto">{{ h.title }}</span>
                    @if (h.rerank_score !== null && h.rerank_score !== undefined) {
                      <span class="mono nowrap" title="Re-ranker relevance (higher is better)">rerank {{ h.rerank_score.toFixed(2) }}</span>
                    }
                    <span class="mono nowrap" title="Fused rank score">score {{ h.score.toFixed(4) }}</span>
                    <span class="mono nowrap" title="Cosine similarity">sim {{ h.similarity === null ? '—' : h.similarity.toFixed(3) }}</span>
                    @if (h.lexical) {<app-badge value="info" tone="info" text="keyword match" />}
                  </div>
                  @if (h.heading) {<div class="subtle" dir="auto">{{ h.heading }}</div>}
                  <p class="small" style="white-space: pre-wrap; overflow-wrap: anywhere" dir="auto">{{ h.content }}</p>
                </li>
              }
            </ol>
          } @else {
            <div class="card">
              <app-empty-state heading="Nothing found" icon="⌕" message="No chunk matched. Check that documents are ready, or rephrase." />
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class SearchTab {
  private readonly api = inject(CollectionsApi);
  private readonly ctx = inject(WorkspaceContext);
  private readonly store = inject(CollectionStore);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly result = signal<SearchOut | null>(null);
  protected readonly floor = computed(() => this.store.collection()?.settings.similarity_floor ?? '—');
  protected readonly form = inject(FormBuilder).nonNullable.group({
    query: ['', [Validators.required, Validators.maxLength(2000)]],
    top_k: [this.store.collection()?.settings.top_k ?? 8, [Validators.required, Validators.min(1), Validators.max(30)]],
    rewrite: [false],
  });
  protected readonly usd = formatUsd;

  protected async search(): Promise<void> {
    const v = this.form.getRawValue();
    if (!v.query.trim()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      this.result.set(
        await firstValueFrom(
          this.api.search(this.ctx.require(), { query: v.query.trim(), collection_id: this.store.collectionId, top_k: v.top_k, rewrite: v.rewrite }),
        ),
      );
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
