import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injectable,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** Optional checkbox (e.g. "also delete its documents"). */
  checkboxLabel?: string;
  /** Require typing this text to enable the confirm button (for destructive actions). */
  typeToConfirm?: string;
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (r: ConfirmResult) => void;
}

/** In-page confirmation dialogs (never `window.confirm`). */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<PendingConfirm | null>(null);

  ask(opts: ConfirmOptions): Promise<ConfirmResult> {
    this.pending()?.resolve({ confirmed: false, checked: false });
    return new Promise((resolve) => this.pending.set({ ...opts, resolve }));
  }

  async confirm(opts: ConfirmOptions): Promise<boolean> {
    return (await this.ask(opts)).confirmed;
  }

  settle(result: ConfirmResult): void {
    const p = this.pending();
    if (!p) return;
    this.pending.set(null);
    p.resolve(result);
  }
}

@Component({
  selector: 'app-confirm-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg class="modal" aria-labelledby="confirm-title" aria-describedby="confirm-msg" (close)="cancel()">
      @if (svc.pending(); as p) {
        <form method="dialog" class="modal-inner" (submit)="$event.preventDefault(); accept()">
          <h2 id="confirm-title" class="modal-title">{{ p.title }}</h2>
          <p id="confirm-msg" class="modal-text">{{ p.message }}</p>
          @if (p.checkboxLabel) {
            <label class="check">
              <input type="checkbox" [checked]="checked()" (change)="checked.set(!checked())" />
              {{ p.checkboxLabel }}
            </label>
          }
          @if (p.typeToConfirm) {
            <label class="field">
              <span class="label">Type <strong>{{ p.typeToConfirm }}</strong> to confirm</span>
              <input class="input" autocomplete="off" [value]="typed()" (input)="typed.set(val($event))" />
            </label>
          }
          <div class="modal-actions">
            <button type="button" class="btn" (click)="cancel()">{{ p.cancelLabel ?? 'Cancel' }}</button>
            <button
              type="submit"
              class="btn"
              [class.btn-danger]="p.danger"
              [class.btn-primary]="!p.danger"
              [disabled]="!!p.typeToConfirm && typed() !== p.typeToConfirm"
            >
              {{ p.confirmLabel ?? 'Confirm' }}
            </button>
          </div>
        </form>
      }
    </dialog>
  `,
})
export class ConfirmHost {
  protected readonly svc = inject(ConfirmService);
  protected readonly checked = signal(false);
  protected readonly typed = signal('');
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg().nativeElement;
      if (this.svc.pending()) {
        this.checked.set(false);
        this.typed.set('');
        if (!el.open) el.showModal?.();
      } else if (el.open) {
        el.close();
      }
    });
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected accept(): void {
    this.svc.settle({ confirmed: true, checked: this.checked() });
  }

  protected cancel(): void {
    this.svc.settle({ confirmed: false, checked: false });
  }
}
