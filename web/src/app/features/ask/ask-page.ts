import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { AskApi } from '../../api/ask.service';
import { CollectionsApi } from '../../api/collections.service';
import { ApiError, apiErrorMessage } from '../../api/errors';
import { AskEvent, CollectionOut, ConversationOut } from '../../api/models';
import { WorkspacesApi } from '../../api/workspaces.service';
import { ToastService } from '../../core/toast.service';
import { WorkspaceContext } from '../../core/workspace-context';
import { ConfirmService } from '../../shared/confirm';
import { EmptyState } from '../../shared/empty-state';
import { inputValue } from '../../shared/format';
import { ChatMessageView } from './chat-message';
import { ChatMessage, fromServer } from './chat-types';
import { ConversationList } from './conversation-list';
import { SourcesPanel } from './sources-panel';

const MAX_QUESTION = 4000;
const lastCollectionKey = (ws: string) => `ragdag.lastCollection.${ws}`;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

@Component({
  selector: 'app-ask-page',
  imports: [RouterLink, EmptyState, ConversationList, SourcesPanel, ChatMessageView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './ask-page.css',
  template: `
    <div class="ask" [class.history-open]="showHistory()" [class.sources-open]="showSources()">
      <aside class="history" aria-label="Conversation history">
        <app-conversation-list [conversations]="conversations()" [activeId]="activeConvId()" [loading]="convLoading()"
          (open)="openConversation($event)" (remove)="deleteConversation($event)" (newChat)="newChat()" />
      </aside>

      <section class="chat" aria-label="Chat">
        <div class="chat-bar">
          <button type="button" class="btn btn-sm btn-ghost toggle-history" (click)="showHistory.set(!showHistory())"
            [attr.aria-expanded]="showHistory()">☰ <span class="hide-xs">History</span></button>
          @if (collections()?.length) {
            <label class="row gap-sm picker">
              <span class="small muted hide-xs">Collection</span>
              <select class="select input-sm" [value]="collectionId() ?? ''" (change)="pickCollection($event)" [disabled]="streaming()">
                @for (c of collections(); track c.id) {
                  <option [value]="c.id" [selected]="c.id === collectionId()">{{ c.name }} ({{ c.ready_count }})</option>
                }
              </select>
            </label>
          }
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm btn-ghost toggle-sources" (click)="showSources.set(!showSources())"
            [attr.aria-expanded]="showSources()">Sources @if (selectedSources().length) {({{ selectedSources().length }})}</button>
        </div>

        @if (collections() === null) {
          <p class="muted pad" role="status">{{ collectionsError() ?? 'Loading…' }}</p>
        } @else if (!collections()!.length) {
          <div class="pad">
            <app-empty-state heading="Nothing to ask yet" icon="?"
              [message]="ctx.canEdit()
                ? 'Questions are answered from a collection of your documents. Create a collection and upload a few files first.'
                : 'Questions are answered from a collection of documents. Ask an editor to create one.'">
              @if (ctx.canEdit()) {
                <a class="btn btn-primary" [routerLink]="['/w', ctx.wsId(), 'collections']">Create a collection</a>
              }
            </app-empty-state>
          </div>
        } @else {
          @if (apiKeyMissing()) {
            <div class="callout banner" data-tone="warning" role="status">
              <div class="callout-body small">
                <strong>No Anthropic API key configured.</strong>
                @if (ctx.isAdmin()) {
                  Questions cannot be answered until you <a [routerLink]="['/w', ctx.wsId(), 'settings']" fragment="api-key">add a key in Settings</a>.
                } @else {
                  Questions cannot be answered until a workspace admin adds one.
                }
              </div>
            </div>
          }

          <div #thread class="thread" (scroll)="onScroll()" tabindex="-1">
            @if (threadLoading()) {
              <p class="muted" role="status">Loading conversation…</p>
            } @else if (!messages().length) {
              <div class="intro">
                <h1>Ask {{ collection()?.name }}</h1>
                <p class="muted">
                  Answers are written by Claude from this collection's documents only, with numbered citations you can click to see the source.
                  @if (collection() && collection()!.ready_count === 0) {
                    <br /><strong>This collection has no ready documents yet.</strong>
                    <a [routerLink]="['/w', ctx.wsId(), 'collections', collection()!.id, 'documents']">Add documents</a>.
                  }
                </p>
              </div>
            } @else {
              <ol class="msgs" aria-label="Messages">
                @for (m of messages(); track m.key) {
                  <li>
                    <app-chat-message [message]="m" [selected]="m.key === selectedKey()" [isAdmin]="ctx.isAdmin()" [wsId]="ctx.require()"
                      (cite)="onCite(m, $event)" (showSources)="onShowSources(m)" />
                  </li>
                }
              </ol>
            }
          </div>

          <form class="composer" (submit)="$event.preventDefault(); send()">
            <label class="sr-only" for="question">Your question</label>
            <textarea id="question" #box class="textarea" rows="1" dir="auto" [value]="draft()" (input)="onInput($event)" (keydown)="onKeydown($event)"
              [attr.maxlength]="maxLen" placeholder="Ask a question about this collection…" aria-describedby="composer-hint"></textarea>
            @if (streaming()) {
              <button type="button" class="btn btn-danger" (click)="stop()">■ Stop</button>
            } @else {
              <button type="submit" class="btn btn-primary" [disabled]="!draft().trim() || !collectionId()">Send</button>
            }
            <p id="composer-hint" class="subtle hint-line">
              Enter to send · Shift+Enter for a new line
              @if (draft().length > maxLen - 200) {<span> · {{ draft().length }}/{{ maxLen }}</span>}
            </p>
          </form>
        }
        <p class="sr-only" aria-live="polite">{{ announce() }}</p>
      </section>

      <aside class="sources" aria-label="Sources">
        <app-sources-panel [sources]="selectedSources()" [highlight]="highlight()" [focusTick]="focusTick()"
          [wsId]="ctx.require()" [collectionId]="collectionId() ?? ''" (close)="showSources.set(false)" />
      </aside>
      <div class="scrim" aria-hidden="true" (click)="showHistory.set(false); showSources.set(false)"></div>
    </div>
  `,
})
export class AskPage implements OnDestroy {
  protected readonly ctx = inject(WorkspaceContext);
  private readonly collectionsApi = inject(CollectionsApi);
  private readonly askApi = inject(AskApi);
  private readonly wsApi = inject(WorkspacesApi);
  private readonly toast = inject(ToastService);
  private readonly confirm = inject(ConfirmService);
  private readonly router = inject(Router);

  /** Query params: ?c=<collection>&conv=<conversation> */
  readonly c = input<string | undefined>();
  readonly conv = input<string | undefined>();

  protected readonly maxLen = MAX_QUESTION;
  protected readonly collections = signal<CollectionOut[] | null>(null);
  protected readonly collectionsError = signal<string | null>(null);
  protected readonly apiKeyMissing = signal(false);
  protected readonly conversations = signal<ConversationOut[]>([]);
  protected readonly convLoading = signal(false);
  protected readonly messages = signal<ChatMessage[]>([]);
  protected readonly threadLoading = signal(false);
  protected readonly activeConvId = signal<string | null>(null);
  protected readonly streaming = signal(false);
  protected readonly draft = signal('');
  protected readonly selectedKey = signal<string | null>(null);
  protected readonly highlight = signal<number | null>(null);
  protected readonly focusTick = signal(0);
  protected readonly showHistory = signal(false);
  protected readonly showSources = signal(false);
  protected readonly announce = signal('');

  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');
  private readonly box = viewChild<ElementRef<HTMLTextAreaElement>>('box');
  private abort: AbortController | null = null;
  private stickToBottom = true;
  private loadSeq = 0;

  protected readonly collectionId = computed(() => {
    const list = this.collections();
    if (!list?.length) return null;
    const wanted = this.c() ?? readStorage(lastCollectionKey(this.ctx.require()));
    return list.find((x) => x.id === wanted)?.id ?? list[0].id;
  });
  protected readonly collection = computed(() => this.collections()?.find((x) => x.id === this.collectionId()) ?? null);

  protected readonly selectedSources = computed(() => {
    const msgs = this.messages();
    const sel = msgs.find((m) => m.key === this.selectedKey());
    const fallback = [...msgs].reverse().find((m) => m.role === 'assistant');
    return (sel ?? fallback)?.sources ?? [];
  });

  constructor() {
    void this.init();

    effect(() => {
      const id = this.collectionId();
      if (!id) return;
      untracked(() => {
        writeStorage(lastCollectionKey(this.ctx.require()), id);
        void this.loadConversations(id);
      });
    });

    effect(() => {
      const conv = this.conv() ?? null;
      const coll = this.collectionId();
      untracked(() => {
        if (!coll || this.streaming()) return;
        if (conv && conv !== this.activeConvId()) void this.loadConversation(conv);
        else if (!conv && this.activeConvId()) this.resetThread();
      });
    });

    afterRenderEffect(() => {
      this.messages();
      const el = this.thread()?.nativeElement;
      if (el && this.stickToBottom) el.scrollTop = el.scrollHeight;
    });
  }

  ngOnDestroy(): void {
    this.abort?.abort();
  }

  private async init(): Promise<void> {
    const ws = this.ctx.require();
    try {
      this.collections.set(await firstValueFrom(this.collectionsApi.list(ws)));
    } catch (e) {
      this.collectionsError.set(apiErrorMessage(e));
    }
    try {
      const key = await firstValueFrom(this.wsApi.apiKey(ws));
      this.apiKeyMissing.set(!key.configured);
    } catch {
      // the ask call will report it
    }
  }

  // ---------------------------------------------------------------- conversations

  private async loadConversations(collectionId: string, quiet = false): Promise<void> {
    if (!quiet) this.convLoading.set(true);
    try {
      const list = await firstValueFrom(this.askApi.conversations(this.ctx.require(), collectionId));
      if (collectionId === this.collectionId()) this.conversations.set(list);
    } catch (e) {
      if (!quiet) this.toast.error(e);
    } finally {
      this.convLoading.set(false);
    }
  }

  private async loadConversation(id: string): Promise<void> {
    const seq = ++this.loadSeq;
    this.activeConvId.set(id);
    this.threadLoading.set(true);
    this.messages.set([]);
    this.selectedKey.set(null);
    this.highlight.set(null);
    try {
      const detail = await firstValueFrom(this.askApi.conversation(this.ctx.require(), id));
      if (seq !== this.loadSeq) return;
      if (detail.collection_id !== this.collectionId()) {
        // Opened via a link for another collection: switch to it.
        void this.router.navigate([], { queryParams: { c: detail.collection_id, conv: id }, queryParamsHandling: 'merge', replaceUrl: true });
      }
      this.stickToBottom = true;
      this.messages.set(detail.messages.map(fromServer));
    } catch (e) {
      if (seq !== this.loadSeq) return;
      this.toast.error(e);
      this.activeConvId.set(null);
      void this.router.navigate([], { queryParams: { conv: null }, queryParamsHandling: 'merge', replaceUrl: true });
    } finally {
      if (seq === this.loadSeq) this.threadLoading.set(false);
    }
  }

  private resetThread(): void {
    this.loadSeq++;
    this.activeConvId.set(null);
    this.messages.set([]);
    this.selectedKey.set(null);
    this.highlight.set(null);
    this.threadLoading.set(false);
  }

  protected openConversation(id: string): void {
    this.showHistory.set(false);
    if (this.streaming()) this.stop();
    void this.router.navigate([], { queryParams: { c: this.collectionId(), conv: id }, queryParamsHandling: 'merge' });
  }

  protected newChat(): void {
    this.showHistory.set(false);
    if (this.streaming()) this.stop();
    this.resetThread();
    void this.router.navigate([], { queryParams: { c: this.collectionId(), conv: null }, queryParamsHandling: 'merge' });
    this.box()?.nativeElement.focus();
  }

  protected pickCollection(e: Event): void {
    const id = inputValue(e);
    this.resetThread();
    void this.router.navigate([], { queryParams: { c: id, conv: null }, queryParamsHandling: 'merge' });
  }

  protected async deleteConversation(c: ConversationOut): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete conversation?',
      message: `“${c.title}” and its messages will be deleted.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await firstValueFrom(this.askApi.deleteConversation(this.ctx.require(), c.id));
      this.conversations.update((list) => list.filter((x) => x.id !== c.id));
      if (this.activeConvId() === c.id) this.newChat();
      this.toast.success('Conversation deleted.');
    } catch (e) {
      this.toast.error(e);
    }
  }

  // ---------------------------------------------------------------- composer

  protected onInput(e: Event): void {
    const el = e.target as HTMLTextAreaElement;
    this.draft.set(el.value);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }

  protected onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.send();
    }
  }

  protected onScroll(): void {
    const el = this.thread()?.nativeElement;
    if (el) this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  protected stop(): void {
    this.abort?.abort();
  }

  private patch(key: string, fn: (m: ChatMessage) => ChatMessage): void {
    this.messages.update((list) => list.map((m) => (m.key === key ? fn(m) : m)));
  }

  protected async send(): Promise<void> {
    const question = this.draft().trim().slice(0, MAX_QUESTION);
    const collectionId = this.collectionId();
    if (!question || !collectionId || this.streaming()) return;

    const stamp = Date.now();
    const aKey = `pending-a-${stamp}`;
    const base = { sources: [], model: null, usage: {}, latencyMs: null, createdAt: new Date().toISOString() };
    this.messages.update((list) => [
      ...list,
      { ...base, key: `pending-u-${stamp}`, role: 'user', content: question, status: 'ok' },
      { ...base, key: aKey, role: 'assistant', content: '', status: 'streaming' },
    ]);
    this.draft.set('');
    const box = this.box()?.nativeElement;
    if (box) box.style.height = 'auto';
    this.selectedKey.set(aKey);
    this.highlight.set(null);
    this.stickToBottom = true;
    this.streaming.set(true);
    this.announce.set('Answering…');

    const abort = new AbortController();
    this.abort = abort;
    const startedNew = !this.activeConvId();
    let key = aKey;

    try {
      await this.askApi.ask(
        this.ctx.require(),
        { question, collection_id: collectionId, conversation_id: this.activeConvId() },
        (ev) => (key = this.onEvent(key, ev, startedNew, collectionId)),
        abort.signal,
      );
      this.patch(key, (m) =>
        m.status === 'streaming' ? { ...m, status: 'error', notice: 'The answer stream ended unexpectedly. Try again.' } : m,
      );
    } catch (e) {
      if (abort.signal.aborted) {
        this.patch(key, (m) => ({ ...m, status: 'stopped', notice: 'Stopped. The partial answer was saved to this conversation.' }));
        this.announce.set('Stopped.');
      } else if (e instanceof ApiError && e.status === 409) {
        this.apiKeyMissing.set(true);
        this.patch(key, (m) => ({ ...m, status: 'error', needsApiKey: true }));
        this.announce.set('No API key is configured for this workspace.');
      } else {
        const message = apiErrorMessage(e);
        this.patch(key, (m) => ({ ...m, status: 'error', notice: message }));
        this.announce.set(`Error: ${message}`);
      }
    } finally {
      this.streaming.set(false);
      if (this.abort === abort) this.abort = null;
      void this.loadConversations(collectionId, true);
    }
  }

  /** Apply one stream event; returns the (possibly renamed) key of the assistant message. */
  private onEvent(key: string, ev: AskEvent, startedNew: boolean, collectionId: string): string {
    switch (ev.event) {
      case 'meta':
        this.activeConvId.set(ev.data.conversation_id);
        if (startedNew) {
          void this.router.navigate([], {
            queryParams: { c: collectionId, conv: ev.data.conversation_id },
            queryParamsHandling: 'merge',
            replaceUrl: true,
          });
          void this.loadConversations(collectionId, true);
        }
        return key;
      case 'plan':
        this.patch(key, (m) => ({ ...m, usage: { ...m.usage, search: ev.data } }));
        return key;
      case 'sources':
        this.patch(key, (m) => ({ ...m, sources: ev.data.sources ?? [] }));
        return key;
      case 'delta':
        this.patch(key, (m) => ({ ...m, content: m.content + (ev.data.text ?? '') }));
        return key;
      case 'reset':
        this.patch(key, (m) => ({ ...m, content: '' }));
        return key;
      case 'done': {
        const saved = fromServer(ev.data.message);
        // Keep the streamed candidates if the server cited none (so the panel is not empty).
        this.patch(key, (m) => ({ ...saved, sources: saved.sources.length || saved.status === 'no_evidence' ? saved.sources : m.sources }));
        if (this.selectedKey() === key) this.selectedKey.set(saved.key);
        this.announce.set(saved.status === 'ok' ? 'Answer complete.' : `Answer finished: ${saved.status.replace('_', ' ')}.`);
        return saved.key;
      }
      case 'error':
        this.patch(key, (m) => ({ ...m, status: 'error', notice: ev.data.message }));
        this.announce.set(`Error: ${ev.data.message}`);
        return key;
    }
  }

  // ---------------------------------------------------------------- citations

  protected onCite(m: ChatMessage, n: number): void {
    this.selectedKey.set(m.key);
    this.highlight.set(n);
    this.focusTick.update((t) => t + 1);
    this.showSources.set(true);
  }

  protected onShowSources(m: ChatMessage): void {
    this.selectedKey.set(m.key);
    this.highlight.set(null);
    this.showSources.set(true);
  }
}
