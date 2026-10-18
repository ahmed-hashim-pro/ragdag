import { ChangeDetectionStrategy, Component, effect, inject, input, untracked } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { WorkspaceContext } from '../../core/workspace-context';
import { formatNumber } from '../../shared/format';
import { CollectionStore } from './collection-store';

@Component({
  selector: 'app-collection-detail',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  providers: [CollectionStore],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <nav class="subtle" aria-label="Breadcrumb" style="margin-bottom: 8px">
        <a [routerLink]="['/w', ctx.wsId(), 'collections']">Collections</a> ›
      </nav>
      @if (store.collection(); as c) {
        <div class="page-head">
          <div class="page-title">
            <h1>{{ c.name }}</h1>
            <p>
              {{ c.description || 'No description.' }}
              <span class="subtle">· {{ n(c.document_count) }} documents · {{ n(c.ready_count) }} ready · {{ n(c.chunk_count) }} chunks</span>
            </p>
          </div>
          <a class="btn btn-primary" [routerLink]="['/w', ctx.wsId(), 'ask']" [queryParams]="{ c: c.id }">Ask this collection</a>
        </div>
        <nav class="tabs" aria-label="Collection sections">
          <a class="tab" routerLink="documents" routerLinkActive="active" ariaCurrentWhenActive="page">Documents</a>
          <a class="tab" routerLink="sources" routerLinkActive="active" ariaCurrentWhenActive="page">Sources</a>
          <a class="tab" routerLink="search" routerLinkActive="active" ariaCurrentWhenActive="page">Search playground</a>
          <a class="tab" routerLink="settings" routerLinkActive="active" ariaCurrentWhenActive="page">Settings</a>
        </nav>
        <router-outlet />
      } @else if (store.error()) {
        <p class="callout" data-tone="danger" role="alert">{{ store.error() }}</p>
      } @else {
        <p class="muted" role="status">Loading collection…</p>
      }
    </div>
  `,
})
export class CollectionDetail {
  protected readonly ctx = inject(WorkspaceContext);
  protected readonly store = inject(CollectionStore);
  protected readonly n = formatNumber;
  readonly collectionId = input.required<string>();

  constructor() {
    effect(() => {
      const id = this.collectionId();
      untracked(() => void this.store.load(id));
    });
  }
}
