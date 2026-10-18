import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { LoadingService } from './core/loading';
import { ToastService } from './core/toast.service';
import { ConfirmHost } from './shared/confirm';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ConfirmHost],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="skip-link" href="#main">Skip to content</a>
    <div class="progress" [class.progress-active]="loading.busy()" role="progressbar" aria-label="Loading"
      [attr.aria-hidden]="!loading.busy()" [attr.aria-busy]="loading.busy()"></div>
    <router-outlet />
    <div class="toasts" aria-live="polite" aria-relevant="additions">
      @for (t of toast.toasts(); track t.id) {
        <div class="toast" [attr.data-kind]="t.kind" [attr.role]="t.kind === 'error' ? 'alert' : 'status'">
          <span class="toast-msg">{{ t.message }}</span>
          <button type="button" class="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss" (click)="toast.dismiss(t.id)">✕</button>
        </div>
      }
    </div>
    <app-confirm-host />
  `,
})
export class App {
  protected readonly loading = inject(LoadingService);
  protected readonly toast = inject(ToastService);
}
