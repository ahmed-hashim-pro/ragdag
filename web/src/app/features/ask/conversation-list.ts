import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ConversationOut } from '../../api/models';
import { relativeTime } from '../../shared/format';

@Component({
  selector: 'app-conversation-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="conv-head">
      <h2 class="conv-title">Conversations</h2>
      <button type="button" class="btn btn-sm btn-primary" (click)="newChat.emit()">+ New</button>
    </div>
    @if (loading() && !conversations().length) {
      <p class="subtle conv-empty" role="status">Loading…</p>
    } @else {
      <ul class="conv-list" role="list">
        @for (c of conversations(); track c.id) {
          <li class="conv" [class.active]="c.id === activeId()">
            <button type="button" class="conv-open" (click)="open.emit(c.id)" [attr.aria-current]="c.id === activeId() ? 'true' : null">
              <span class="conv-name truncate">{{ c.title || 'Untitled' }}</span>
              <span class="subtle">{{ rel(c.updated_at) }}</span>
            </button>
            <button type="button" class="btn btn-ghost btn-icon btn-sm conv-del" [attr.aria-label]="'Delete conversation: ' + c.title"
              (click)="remove.emit(c)">🗑</button>
          </li>
        } @empty {
          <li class="subtle conv-empty">No conversations yet. Ask a question to start one.</li>
        }
      </ul>
    }
  `,
  styles: `
    :host { display: flex; flex-direction: column; min-height: 0; }
    .conv-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 10px; }
    .conv-title { flex: 1; font-size: 0.95rem; }
    .conv-list { list-style: none; margin: 0; padding: 0 8px 12px; overflow-y: auto; flex: 1; }
    .conv { display: flex; align-items: center; border-radius: var(--radius-sm); }
    .conv:hover, .conv.active { background: var(--bg-hover); }
    .conv.active { box-shadow: inset 3px 0 0 var(--accent); }
    .conv-open { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      padding: 8px 10px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: var(--radius-sm); }
    .conv-name { max-width: 100%; font-size: 0.9rem; font-weight: 550; }
    .conv-del { opacity: 0; font-size: 0.8rem; }
    .conv:hover .conv-del, .conv-del:focus-visible, .conv.active .conv-del { opacity: 0.7; }
    .conv-empty { padding: 8px 12px; }
    @media (hover: none) { .conv-del { opacity: 0.6; } }
  `,
})
export class ConversationList {
  readonly conversations = input.required<ConversationOut[]>();
  readonly activeId = input<string | null>(null);
  readonly loading = input(false);
  readonly open = output<string>();
  readonly remove = output<ConversationOut>();
  readonly newChat = output<void>();
  protected readonly rel = relativeTime;
}
