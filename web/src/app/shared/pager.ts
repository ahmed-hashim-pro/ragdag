import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

/** "Showing 26–50 of 140" with previous / next buttons. Works with offset/limit APIs. */
@Component({
  selector: 'app-pager',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (total() > 0) {
      <nav class="pager" aria-label="Pagination">
        <span class="muted">{{ from() }}–{{ to() }} of {{ total() }}</span>
        <div class="row gap-sm">
          <button type="button" class="btn btn-sm" [disabled]="offset() === 0" (click)="go(offset() - limit())">
            ‹ Previous
          </button>
          <button type="button" class="btn btn-sm" [disabled]="to() >= total()" (click)="go(offset() + limit())">
            Next ›
          </button>
        </div>
      </nav>
    }
  `,
})
export class Pager {
  readonly total = input.required<number>();
  readonly offset = input.required<number>();
  readonly limit = input.required<number>();
  readonly offsetChange = output<number>();

  protected readonly from = computed(() => Math.min(this.total(), this.offset() + 1));
  protected readonly to = computed(() => Math.min(this.total(), this.offset() + this.limit()));

  protected go(next: number): void {
    this.offsetChange.emit(Math.max(0, next));
  }
}
