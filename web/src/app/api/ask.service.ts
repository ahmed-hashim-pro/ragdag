import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';

import { AuthService } from '../core/auth/auth.service';
import { LoadingService } from '../core/loading';
import { SseMessage, SseParser } from '../shared/sse-parser';
import { ApiError, detailMessage } from './errors';
import { API, params } from './http-context';
import { AskEvent, AskIn, ConversationDetailOut, ConversationOut } from './models';

const ASK_EVENTS = new Set(['meta', 'plan', 'sources', 'delta', 'reset', 'done', 'error']);

/** Decode one SSE message into a typed ask event; unknown events and bad JSON yield null. */
export function parseAskEvent(msg: SseMessage): AskEvent | null {
  if (!ASK_EVENTS.has(msg.event)) return null;
  try {
    const data: unknown = JSON.parse(msg.data);
    if (!data || typeof data !== 'object') return null;
    return { event: msg.event, data } as AskEvent;
  } catch {
    return null;
  }
}

/** Read an SSE response body, invoking `onEvent` for every ask event as it arrives. */
export async function readAskStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: AskEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const parser = new SseParser();
  const emit = (messages: SseMessage[]) => {
    for (const m of messages) {
      const ev = parseAskEvent(m);
      if (ev) onEvent(ev);
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) emit(parser.push(value));
    }
    emit(parser.end());
  } finally {
    reader.releaseLock();
  }
}

@Injectable({ providedIn: 'root' })
export class AskApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly loading = inject(LoadingService);

  conversations(ws: string, collectionId?: string, limit = 50): Observable<ConversationOut[]> {
    return this.http.get<ConversationOut[]>(`${API}/w/${ws}/conversations`, {
      params: params({ collection_id: collectionId, limit }),
    });
  }

  conversation(ws: string, id: string): Observable<ConversationDetailOut> {
    return this.http.get<ConversationDetailOut>(`${API}/w/${ws}/conversations/${id}`);
  }

  deleteConversation(ws: string, id: string): Observable<void> {
    return this.http.delete<void>(`${API}/w/${ws}/conversations/${id}`);
  }

  /**
   * `POST /ask`, streamed. Uses fetch (not EventSource) so the Authorization header can be
   * sent. Refreshes the token once on 401. Throws `ApiError` for non-2xx responses (409 means
   * the workspace has no API key) and `DOMException('AbortError')` when `signal` aborts.
   */
  async ask(ws: string, body: AskIn, onEvent: (e: AskEvent) => void, signal: AbortSignal): Promise<void> {
    const url = `${API}/w/${ws}/ask`;
    const send = (token: string | null) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        credentials: 'same-origin',
        signal,
      });

    this.loading.start();
    let res: Response;
    try {
      let token = this.auth.accessToken() ?? (await firstValueFrom(this.auth.refresh()));
      res = await send(token);
      if (res.status === 401) {
        token = await firstValueFrom(this.auth.refresh());
        if (!token) {
          this.auth.sessionExpired();
          throw new ApiError(401, 'Your session has expired. Please sign in again.');
        }
        res = await send(token);
      }
    } finally {
      this.loading.stop();
    }

    if (!res.ok) {
      let message = `The request failed (HTTP ${res.status}).`;
      try {
        message = detailMessage(await res.json()) ?? message;
      } catch {
        // non-JSON error body
      }
      throw new ApiError(res.status, message);
    }
    if (!res.body) throw new ApiError(res.status, 'The server sent an empty response.');
    await readAskStream(res.body, onEvent);
  }
}
