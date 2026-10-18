import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-brand-mark',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'auth-brand' },
  template: `
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="var(--accent)" />
      <circle cx="9" cy="10" r="3.2" fill="var(--accent-fg)" /><circle cx="23" cy="10" r="3.2" fill="var(--accent-fg)" />
      <circle cx="16" cy="23" r="3.2" fill="var(--accent-fg)" />
      <path d="M9 10 16 23M23 10 16 23M9 10h14" stroke="var(--accent-fg)" stroke-width="2" fill="none" />
    </svg>
    <span>ragdag</span>
  `,
})
export class BrandMark {}
