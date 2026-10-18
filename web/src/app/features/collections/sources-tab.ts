import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { apiErrorMessage } from '../../api/errors';
import { SourceIn, SourceKind, SourceOut } from '../../api/models';
import { SourcesApi } from '../../api/sources.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { Badge } from '../../shared/badge';
import { ConfirmService } from '../../shared/confirm';
import { EmptyState } from '../../shared/empty-state';
import { formatDate, relativeTime } from '../../shared/format';
import { CollectionStore } from './collection-store';

const MIN_INTERVAL = 15;
const MAX_INTERVAL = 10080;

@Component({
  selector: 'app-sources-tab',
  imports: [ReactiveFormsModule, RouterLink, Badge, EmptyState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sources-tab.css',
  template: `
    <div class="stack-lg">
      <p class="muted">
        Sources are checked on a schedule by the <code>ragdag_sync_sources</code> pipeline. New or changed content (by SHA-256)
        is ingested automatically.
      </p>

      @if (ctx.canEdit()) {
        @if (showForm()) {
          <form class="card card-pad stack" [formGroup]="form" (ngSubmit)="create()" aria-labelledby="new-src-h">
            <h2 id="new-src-h">Add a source</h2>
            <fieldset class="kind">
              <legend class="label">Kind</legend>
              <label class="check"><input type="radio" formControlName="kind" value="url" /> URL</label>
              <label class="check"><input type="radio" formControlName="kind" value="folder" /> Server folder</label>
            </fieldset>
            <div class="form-grid">
              <label class="field">
                <span class="label">Name</span>
                <input class="input" formControlName="name" maxlength="200" placeholder="e.g. Public handbook" />
              </label>
              @if (form.controls.kind.value === 'url') {
                <label class="field">
                  <span class="label">URL</span>
                  <input class="input" type="url" formControlName="url" maxlength="2000" placeholder="https://example.com/docs/page.html" />
                  <span class="hint">An http(s) page or file (Markdown, text, PDF or HTML).</span>
                </label>
              } @else {
                <label class="field">
                  <span class="label">Folder path</span>
                  <input class="input mono" formControlName="path" maxlength="500" placeholder="team-docs/handbook" />
                  <span class="hint">Relative to the server's mounted sources directory.</span>
                </label>
                <label class="field">
                  <span class="label">File pattern</span>
                  <input class="input mono" formControlName="glob" maxlength="200" />
                  <span class="hint">Glob, e.g. <code>**/*.md</code>.</span>
                </label>
              }
              <label class="field">
                <span class="label">Check every (minutes)</span>
                <input class="input" type="number" formControlName="interval_minutes" [min]="minInterval" [max]="maxInterval" step="5" />
                <span class="hint">At least {{ minInterval }} minutes.</span>
              </label>
            </div>
            <label class="switch"><input type="checkbox" formControlName="enabled" /> Enabled</label>
            @if (error()) {<p class="field-error" role="alert">{{ error() }}</p>}
            <div class="form-actions">
              <button type="button" class="btn" (click)="showForm.set(false)">Cancel</button>
              <button type="submit" class="btn btn-primary" [disabled]="form.invalid || busy()">Add source</button>
            </div>
          </form>
        } @else {
          <div><button type="button" class="btn btn-primary" (click)="openForm()">Add source</button></div>
        }
      }

      @if (sources(); as list) {
        @if (list.length) {
          <ul class="sources" role="list">
            @for (s of list; track s.id) {
              <li class="card src">
                <div class="row row-wrap">
                  <h3 class="truncate" style="flex: 1">{{ s.name }}</h3>
                  <app-badge [value]="s.kind" tone="neutral" />
                  <app-badge [value]="s.enabled ? 'enabled' : 'disabled'" [dot]="true" />
                </div>
                <p class="mono small truncate" [title]="target(s)">{{ target(s) }}</p>
                <dl class="src-meta small">
                  <div><dt>Last synced</dt><dd [title]="fmt(s.last_synced_at)">{{ s.last_synced_at ? rel(s.last_synced_at) : 'never' }}</dd></div>
                  <div><dt>Interval</dt>
                    <dd>
                      @if (ctx.canEdit()) {
                        <label class="row gap-sm">
                          <span class="sr-only">Interval in minutes for {{ s.name }}</span>
                          <input class="input input-sm" style="width: 90px" type="number" [min]="minInterval" [max]="maxInterval"
                            [value]="s.interval_minutes" (change)="setInterval(s, $event)" /> min
                        </label>
                      } @else {
                        every {{ s.interval_minutes }} min
                      }
                    </dd>
                  </div>
                  <div><dt>Runs</dt><dd><a [routerLink]="['/w', ctx.wsId(), 'pipelines']" [queryParams]="{ dag: 'ragdag_sync_sources' }">Sync history</a></dd></div>
                </dl>
                @if (s.last_error) {
                  <p class="callout small" data-tone="danger"><span class="callout-body"><strong>Last error:</strong> {{ s.last_error }}</span></p>
                }
                @if (ctx.canEdit()) {
                  <div class="row row-wrap src-actions">
                    <label class="switch small">
                      <input type="checkbox" [checked]="s.enabled" [disabled]="busyId() === s.id" (change)="toggle(s)" />
                      {{ s.enabled ? 'Enabled' : 'Disabled' }}
                    </label>
                    <span class="spacer"></span>
                    <button type="button" class="btn btn-sm" [disabled]="busyId() === s.id" (click)="sync(s)">Sync now</button>
                    <button type="button" class="btn btn-sm btn-ghost btn-danger-ghost" [disabled]="busyId() === s.id" (click)="remove(s)">Delete</button>
                  </div>
                }
              </li>
            }
          </ul>
        } @else if (!showForm()) {
          <div class="card">
            <app-empty-state heading="No sources" icon="⟳"
              [message]="ctx.canEdit()
                ? 'Connect a URL or a folder on the server and ragdag will keep this collection in sync with it.'
                : 'Editors can connect URL or folder sources.'" />
          </div>
        }
      } @else if (loadError()) {
        <p class="callout" data-tone="danger" role="alert">{{ loadError() }}</p>
      } @else {
        <p class="muted" role="status">Loading sources…</p>
      }
    </div>
  `,
})
export class SourcesTab implements OnInit {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly store = inject(CollectionStore);
  private readonly api = inject(SourcesApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  protected readonly fmt = formatDate;
  protected readonly rel = relativeTime;
  protected readonly minInterval = MIN_INTERVAL;
  protected readonly maxInterval = MAX_INTERVAL;

  protected readonly sources = signal<SourceOut[] | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly showForm = signal(false);
  protected readonly busy = signal(false);
  protected readonly busyId = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    kind: ['url' as SourceKind],
    name: ['', [Validators.required, Validators.maxLength(200)]],
    url: ['', Validators.maxLength(2000)],
    path: ['', Validators.maxLength(500)],
    glob: ['**/*', Validators.maxLength(200)],
    interval_minutes: [60, [Validators.required, Validators.min(MIN_INTERVAL), Validators.max(MAX_INTERVAL)]],
    enabled: [true],
  });

  async ngOnInit(): Promise<void> {
    try {
      this.sources.set(await firstValueFrom(this.api.list(this.store.wsId, this.store.collectionId)));
    } catch (e) {
      this.loadError.set(apiErrorMessage(e));
    }
  }

  protected target(s: SourceOut): string {
    if (s.kind === 'url') return s.config.url ?? '';
    return `${s.config.path ?? ''}${s.config.glob ? ` · ${s.config.glob}` : ''}`;
  }

  protected openForm(): void {
    this.form.reset();
    this.error.set(null);
    this.showForm.set(true);
  }

  private replace(updated: SourceOut): void {
    this.sources.update((list) => (list ?? []).map((x) => (x.id === updated.id ? updated : x)));
  }

  protected async create(): Promise<void> {
    const v = this.form.getRawValue();
    if (v.kind === 'url' && !v.url.trim()) return this.error.set('Enter the URL to fetch.');
    if (v.kind === 'folder' && !v.path.trim()) return this.error.set('Enter the folder path.');
    const body: SourceIn = {
      kind: v.kind,
      name: v.name.trim(),
      interval_minutes: v.interval_minutes,
      enabled: v.enabled,
      ...(v.kind === 'url' ? { url: v.url.trim() } : { path: v.path.trim(), glob: v.glob.trim() || '**/*' }),
    };
    this.busy.set(true);
    this.error.set(null);
    try {
      const src = await firstValueFrom(this.api.create(this.store.wsId, this.store.collectionId, body));
      this.sources.update((list) => [...(list ?? []), src]);
      this.showForm.set(false);
      this.toast.success(`Source “${src.name}” added; the first sync has started.`);
    } catch (e) {
      this.error.set(apiErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async toggle(s: SourceOut): Promise<void> {
    this.busyId.set(s.id);
    try {
      this.replace(await firstValueFrom(this.api.update(this.store.wsId, s.id, { enabled: !s.enabled })));
    } catch (e) {
      this.toast.error(e);
      this.replace({ ...s });
    } finally {
      this.busyId.set(null);
    }
  }

  protected async setInterval(s: SourceOut, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const minutes = Math.round(Number(input.value));
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL || minutes > MAX_INTERVAL) {
      this.toast.error(`The interval must be between ${MIN_INTERVAL} and ${MAX_INTERVAL} minutes.`);
      input.value = String(s.interval_minutes);
      return;
    }
    try {
      this.replace(await firstValueFrom(this.api.update(this.store.wsId, s.id, { interval_minutes: minutes })));
      this.toast.success(`“${s.name}” is now checked every ${minutes} minutes.`);
    } catch (e) {
      input.value = String(s.interval_minutes);
      this.toast.error(e);
    }
  }

  protected async sync(s: SourceOut): Promise<void> {
    this.busyId.set(s.id);
    try {
      await firstValueFrom(this.api.sync(this.store.wsId, s.id));
      this.toast.success(`Sync of “${s.name}” started.`);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busyId.set(null);
    }
  }

  protected async remove(s: SourceOut): Promise<void> {
    const res = await this.confirm.ask({
      title: 'Delete source?',
      message: `“${s.name}” will no longer be synced.`,
      checkboxLabel: 'Also delete the documents it imported',
      confirmLabel: 'Delete source',
      danger: true,
    });
    if (!res.confirmed) return;
    this.busyId.set(s.id);
    try {
      await firstValueFrom(this.api.delete(this.store.wsId, s.id, res.checked));
      this.sources.update((list) => (list ?? []).filter((x) => x.id !== s.id));
      this.toast.success(res.checked ? 'Source and its documents deleted.' : 'Source deleted.');
      if (res.checked) void this.store.refresh();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busyId.set(null);
    }
  }
}
