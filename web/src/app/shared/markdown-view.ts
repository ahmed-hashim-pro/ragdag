import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { MarkdownOptions, renderMarkdown } from './markdown';

/**
 * Renders model output with the in-house markdown renderer. The renderer escapes all input
 * and emits only a fixed set of tags, so bypassing Angular's sanitizer here is safe (and
 * needed: the sanitizer would strip the citation buttons and their data attributes).
 */
@Component({
  selector: 'app-markdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'md' },
  template: `<div [innerHTML]="html()" (click)="onClick($event)"></div>`,
})
export class MarkdownView {
  private readonly sanitizer = inject(DomSanitizer);
  readonly text = input.required<string>();
  readonly citations = input<MarkdownOptions['citations']>('none');
  readonly cite = output<number>();

  protected readonly html = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(this.text(), { citations: this.citations() })),
  );

  protected onClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-cite]');
    if (target) this.cite.emit(Number(target.dataset['cite']));
  }
}
