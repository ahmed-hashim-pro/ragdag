import { Citation, MessageOut, MessageUsage } from '../../api/models';

export type ChatStatus = 'ok' | 'no_evidence' | 'refused' | 'error' | 'streaming' | 'stopped' | string;

/** A message as shown in the thread (server message or one being streamed). */
export interface ChatMessage {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatStatus;
  /** Sources for an assistant message: the cited subset once saved, all candidates while streaming. */
  sources: Citation[];
  model: string | null;
  usage: MessageUsage;
  latencyMs: number | null;
  createdAt: string | null;
  /** Shown under the message (stream errors, API key missing…). */
  notice?: string | null;
  /** 409: no API key configured. */
  needsApiKey?: boolean;
}

export function fromServer(m: MessageOut): ChatMessage {
  return {
    key: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
    status: m.status,
    sources: Array.isArray(m.citations) ? m.citations : [],
    model: m.model,
    usage: m.usage ?? {},
    latencyMs: m.latency_ms,
    createdAt: m.created_at,
  };
}
