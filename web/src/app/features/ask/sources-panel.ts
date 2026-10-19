import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, input, output, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Citation } from '../../api/models';

/** Source cards for the selected answer; the highlighted one is scrolled to and focused. */
@Component({
  selector: 'app-sources-panel',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="src-head">
      <h2 class="src-title">Sources</h2>
      <button type="button" class="btn btn-ghost btn-icon btn-sm src-close" aria-label="Close sources" (click)="close.emit()">✕</button>
    </div>
    <div #list class="src-list">
      @for (s of sources(); track s.n) {
        <article class="src-card" [class.hl]="s.n === highlight()" [attr.id]="'src-' + s.n" tabindex="-1"
          [attr.aria-label]="'Source ' + s.n + ': ' + s.title">
          <header class="row gap-sm">
            <span class="src-n" aria-hidden="true">{{ s.n }}</span>
            <a class="src-doc truncate" [routerLink]="['/w', wsId(), 'collections', collectionId(), 'documents']" [queryParams]="{ doc: s.document_id }"
              [title]="s.title" dir="auto">{{ s.title }}</a>
          </header>
          @if (s.heading) {<p class="subtle src-heading">{{ s.heading }}</p>}
          <p class="src-snippet" dir="auto">{{ s.snippet }}</p>
          <footer class="subtle mono">
            similarity {{ s.similarity === null ? '—' : s.similarity.toFixed(3) }} · score {{ s.score.toFixed(4) }}
          </footer>
        </article>
      } @empty {
        <p class="subtle" style="padding: 4px 2px">{{ emptyText() }}</p>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; }
    .src-head { display: flex; align-items: center; padding: 14px 14px 10px; }
    .src-title { flex: 1; font-size: 0.95rem; }
    .src-list { overflow-y: auto; padding: 0 12px 16px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
    .src-card { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-elev);
      display: flex; flex-direction: column; gap: 6px; transition: border-color .15s, box-shadow .15s; outline: none; }
    .src-card.hl { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .src-n { display: inline-grid; place-items: center; min-width: 22px; height: 22px; border-radius: 999px; background: var(--accent-soft);
      color: var(--accent); font-size: .75rem; font-weight: 700; flex: none; }
    .src-doc { font-weight: 600; font-size: .9rem; color: var(--fg); }
    .src-heading { font-size: .8rem; }
    .src-snippet { font-size: .85rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 14em; overflow: auto; }
    .src-card footer { font-size: .72rem; }
  `,
})
export class SourcesPanel {
  readonly sources = input.required<readonly Citation[]>();
  readonly highlight = input<number | null>(null);
  /** Bumped on every citation click so the same source can be re-focused. */
  readonly focusTick = input(0);
  readonly wsId = input.required<string>();
  readonly collectionId = input.required<string>();
  readonly emptyText = input('Sources for the selected answer appear here.');
  readonly close = output<void>();
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  constructor() {
    afterRenderEffect(() => {
      const n = this.highlight();
      this.focusTick();
      if (n === null) return;
      const el = this.list().nativeElement.querySelector<HTMLElement>(`#src-${n}`);
      el?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    });
  }
}
