import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="empty">
      <div class="empty-icon" aria-hidden="true">{{ icon() }}</div>
      <h3 class="empty-title">{{ heading() }}</h3>
      @if (message()) {
        <p class="empty-text">{{ message() }}</p>
      }
      <div class="empty-actions"><ng-content /></div>
    </div>
  `,
})
export class EmptyState {
  readonly heading = input.required<string>();
  readonly message = input<string>('');
  readonly icon = input<string>('◇');
}
