import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { CollectionsApi } from '../../api/collections.service';
import { apiErrorMessage } from '../../api/errors';
import { CollectionOut } from '../../api/models';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { EmptyState } from '../../shared/empty-state';
import { formatNumber } from '../../shared/format';

@Component({
  selector: 'app-collections-page',
  imports: [ReactiveFormsModule, RouterLink, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './collections-page.css',
  template: `
    <div class="page">
      <div class="page-head">
        <div class="page-title">
          <h1>Collections</h1>
          <p>Each collection is a separate knowledge base with its own documents, sources, and settings.</p>
        </div>
        @if (ctx.canEdit() && !showForm() && collections()?.length) {
          <button type="button" class="btn btn-primary" (click)="openForm()">New collection</button>
        }
      </div>

      @if (showForm()) {
        <form class="card card-pad stack create" [formGroup]="form" (ngSubmit)="create()" aria-labelledby="new-coll-h">
          <h2 id="new-coll-h">New collection</h2>
          <label class="field">
            <span class="label">Name</span>
            <input class="input" formControlName="name" maxlength="120" required placeholder="e.g. Product handbook" />
          </label>
          <label class="field">
            <span class="label">Description <span class="subtle">(optional)</span></span>
            <textarea class="textarea" formControlName="description" rows="2" maxlength="2000"
              placeholder="What is in here, and who is it for?"></textarea>
          </label>
          @if (error()) {<p class="field-error" role="alert">{{ error() }}</p>}
          <div class="form-actions">
            <button type="button" class="btn" (click)="showForm.set(false)">Cancel</button>
            <button type="submit" class="btn btn-primary" [disabled]="form.invalid || busy()">Create collection</button>
          </div>
        </form>
      }

      @if (collections(); as list) {
        @if (list.length) {
          <ul class="grid-cards" role="list">
            @for (c of list; track c.id) {
              <li class="card coll">
                <a class="coll-link" [routerLink]="[c.id]">
                  <h2 class="coll-name">{{ c.name }}</h2>
                  <p class="coll-desc muted">{{ c.description || 'No description' }}</p>
                  <dl class="coll-stats">
                    <div><dt>Documents</dt><dd>{{ n(c.document_count) }}</dd></div>
                    <div><dt>Ready</dt><dd>{{ n(c.ready_count) }}</dd></div>
                    <div><dt>Chunks</dt><dd>{{ n(c.chunk_count) }}</dd></div>
                  </dl>
                </a>
                <div class="coll-actions">
                  <a class="btn btn-sm" [routerLink]="['/w', ctx.wsId(), 'ask']" [queryParams]="{ c: c.id }">Ask</a>
                  <a class="btn btn-sm btn-ghost" [routerLink]="[c.id, 'documents']">Documents</a>
                </div>
              </li>
            }
          </ul>
        } @else if (!showForm()) {
          <div class="card">
            <app-empty-state heading="No collections yet" icon="▤"
              [message]="ctx.canEdit()
                ? 'A collection groups related documents. Create one, then upload files or connect a URL or folder source — ragdag chunks and indexes them so you can ask questions.'
                : 'Nobody has created a collection in this workspace yet. Ask an editor to add one.'">
              @if (ctx.canEdit()) {
                <button type="button" class="btn btn-primary" (click)="openForm()">Create your first collection</button>
              }
            </app-empty-state>
          </div>
        }
      } @else if (loadError()) {
        <p class="callout" data-tone="danger" role="alert">{{ loadError() }}</p>
      } @else {
        <p class="muted" role="status">Loading collections…</p>
      }
    </div>
  `,
})
export class CollectionsPage implements OnInit {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly api = inject(CollectionsApi);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  protected readonly n = formatNumber;

  protected readonly collections = signal<CollectionOut[] | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly showForm = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    description: ['', Validators.maxLength(2000)],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.collections.set(await firstValueFrom(this.api.list(this.ctx.require())));
    } catch (e) {
      this.loadError.set(apiErrorMessage(e));
    }
  }

  protected openForm(): void {
    this.form.reset({ name: '', description: '' });
    this.error.set(null);
    this.showForm.set(true);
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const v = this.form.getRawValue();
      const c = await firstValueFrom(
        this.api.create(this.ctx.require(), { name: v.name.trim(), description: v.description.trim() }),
      );
      this.toast.success(`Collection “${c.name}” created. Add some documents next.`);
      await this.router.navigate(['/w', this.ctx.require(), 'collections', c.id, 'documents']);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
