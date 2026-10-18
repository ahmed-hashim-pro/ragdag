import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

/**
 * Side panel built on a modal `<dialog>`: focus is trapped, Escape closes it, and focus
 * returns to the opener when it closes.
 */
@Component({
  selector: 'app-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dlg class="drawer" [class.drawer-wide]="wide()" [attr.aria-labelledby]="titleId" (close)="onClose()" (click)="backdrop($event)">
      <div class="drawer-inner">
        <header class="drawer-head">
          <h2 [id]="titleId" class="drawer-title">{{ heading() }}</h2>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="Close" (click)="dlg.close()">✕</button>
        </header>
        <div class="drawer-body">
          @if (open()) {
            <ng-content />
          }
        </div>
      </div>
    </dialog>
  `,
})
export class Drawer {
  private static seq = 0;
  readonly open = input.required<boolean>();
  readonly heading = input.required<string>();
  readonly wide = input(false);
  readonly closed = output<void>();
  protected readonly titleId = `drawer-title-${++Drawer.seq}`;
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  constructor() {
    effect(() => {
      const el = this.dlg().nativeElement;
      if (this.open() && !el.open) el.showModal?.();
      else if (!this.open() && el.open) el.close();
    });
  }

  protected onClose(): void {
    if (this.open()) this.closed.emit();
  }

  protected backdrop(event: MouseEvent): void {
    if (event.target === this.dlg().nativeElement) this.dlg().nativeElement.close();
  }
}
