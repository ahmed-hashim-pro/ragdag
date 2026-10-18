import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { CollectionsApi } from '../../api/collections.service';
import { apiErrorMessage } from '../../api/errors';
import { CollectionOut } from '../../api/models';
import { WorkspaceContext } from '../../core/workspace-context';

/** The collection being viewed; provided by CollectionDetail and shared with its tabs. */
@Injectable()
export class CollectionStore {
  private readonly api = inject(CollectionsApi);
  private readonly ctx = inject(WorkspaceContext);

  readonly collection = signal<CollectionOut | null>(null);
  readonly error = signal<string | null>(null);
  private id: string | null = null;

  get collectionId(): string {
    if (!this.id) throw new Error('collection not loaded');
    return this.id;
  }

  get wsId(): string {
    return this.ctx.require();
  }

  async load(id: string): Promise<void> {
    if (id !== this.id) this.collection.set(null);
    this.id = id;
    this.error.set(null);
    try {
      this.collection.set(await firstValueFrom(this.api.get(this.wsId, id)));
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    }
  }

  /** Refresh counts quietly (after uploads etc.). */
  async refresh(): Promise<void> {
    if (!this.id) return;
    try {
      this.collection.set(await firstValueFrom(this.api.get(this.wsId, this.id)));
    } catch {
      // keep the stale copy
    }
  }

  set(c: CollectionOut): void {
    this.collection.set(c);
  }
}
