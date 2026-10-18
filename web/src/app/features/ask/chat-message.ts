import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Badge } from '../../shared/badge';
import { formatDuration, formatNumber, formatUsd } from '../../shared/format';
import { MarkdownView } from '../../shared/markdown-view';
import { ChatMessage } from './chat-types';

@Component({
  selector: 'app-chat-message',
  imports: [MarkdownView, Badge, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './chat-message.css',
  template: `
    @let m = message();
    @if (m.role === 'user') {
      <div class="msg msg-user">
        <h3 class="sr-only">You asked</h3>
        <p class="bubble">{{ m.content }}</p>
      </div>
    } @else {
      <div class="msg msg-assistant" [class.selected]="selected()" [attr.aria-busy]="m.status === 'streaming'"
        [attr.aria-live]="m.status === 'streaming' ? 'polite' : null">
        <h3 class="sr-only">Answer</h3>
        @if (statusBadge(); as s) {
          <div class="row gap-sm status"><app-badge [value]="s" [dot]="true" [text]="statusText()" /></div>
        }
        @if (m.content) {
          <app-markdown [text]="m.content" [citations]="citationSet()" (cite)="cite.emit($event)" />
        } @else if (m.status === 'streaming') {
          <p class="thinking" role="status"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
            {{ m.sources.length ? 'Writing the answer…' : 'Searching the collection…' }}</p>
        }
        @if (m.status === 'streaming' && m.content) {<span class="caret" aria-hidden="true"></span>}

        @if (m.needsApiKey) {
          <div class="callout" data-tone="warning" role="alert">
            <div class="callout-body">
              <strong>No Anthropic API key is configured for this workspace.</strong>
              @if (isAdmin()) {
                <p class="small">Add one under <a [routerLink]="['/w', wsId(), 'settings']" fragment="api-key">Settings → Anthropic API key</a>, then ask again.</p>
              } @else {
                <p class="small">Ask a workspace admin to add one in Settings.</p>
              }
            </div>
          </div>
        } @else if (m.notice) {
          <p class="callout small" [attr.data-tone]="m.status === 'stopped' ? 'info' : 'danger'" role="alert">{{ m.notice }}</p>
        }

        @if (m.status !== 'streaming') {
          <div class="foot">
            @if (m.sources.length) {
              <button type="button" class="link-btn" (click)="showSources.emit()">{{ m.sources.length }} source{{ m.sources.length === 1 ? '' : 's' }}</button>
            }
            @if (tokens()) {<span title="Input / output tokens">{{ tokens() }}</span>}
            @if (m.latencyMs !== null) {<span>{{ latency() }}</span>}
            @if (m.model) {<span class="mono">{{ m.model }}</span>}
          </div>
        }
      </div>
    }
  `,
})
export class ChatMessageView {
  readonly message = input.required<ChatMessage>();
  readonly selected = input(false);
  readonly isAdmin = input(false);
  readonly wsId = input.required<string>();
  readonly cite = output<number>();
  readonly showSources = output<void>();

  protected readonly citationSet = computed(() => new Set(this.message().sources.map((s) => s.n)));

  protected readonly statusBadge = computed(() => {
    const s = this.message().status;
    return s === 'no_evidence' || s === 'refused' || s === 'error' || s === 'stopped' ? s : null;
  });

  protected readonly statusText = computed(() => {
    switch (this.message().status) {
      case 'no_evidence':
        return 'no evidence in this collection';
      case 'refused':
        return 'declined by safety checks';
      case 'error':
        return 'error';
      case 'stopped':
        return 'stopped';
      default:
        return null;
    }
  });

  protected readonly tokens = computed(() => {
    const u = this.message().usage;
    if (!u || (!u.input_tokens && !u.output_tokens)) return '';
    const tokens = `${formatNumber(u.input_tokens ?? 0)} in · ${formatNumber(u.output_tokens ?? 0)} out tokens`;
    return typeof u.cost_usd === 'number' ? `${tokens} · ≈ ${formatUsd(u.cost_usd)}` : tokens;
  });

  protected readonly latency = computed(() => formatDuration((this.message().latencyMs ?? 0) / 1000));
}
