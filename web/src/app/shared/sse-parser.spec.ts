import { readAskStream } from '../api/ask.service';
import { AskEvent } from '../api/models';
import { SseMessage, SseParser } from './sse-parser';

const enc = new TextEncoder();

function feed(chunks: (string | Uint8Array)[]): SseMessage[] {
  const p = new SseParser();
  const out: SseMessage[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

describe('SseParser', () => {
  it('parses a single complete event', () => {
    expect(feed(['event: delta\ndata: {"text":"hi"}\n\n'])).toEqual([{ event: 'delta', data: '{"text":"hi"}' }]);
  });

  it('parses multiple events delivered in one chunk', () => {
    const msgs = feed(['event: meta\ndata: {"a":1}\n\nevent: delta\ndata: {"text":"x"}\n\nevent: delta\ndata: {"text":"y"}\n\n']);
    expect(msgs.map((m) => m.event)).toEqual(['meta', 'delta', 'delta']);
    expect(msgs[2].data).toBe('{"text":"y"}');
  });

  it('reassembles events split across reads at arbitrary points', () => {
    const whole = 'event: sources\ndata: {"sources":[]}\n\nevent: delta\ndata: {"text":"Hello"}\n\n';
    for (let i = 1; i < whole.length; i++) {
      const msgs = feed([whole.slice(0, i), whole.slice(i)]);
      expect(msgs).toEqual([
        { event: 'sources', data: '{"sources":[]}' },
        { event: 'delta', data: '{"text":"Hello"}' },
      ]);
    }
  });

  it('handles one byte per read', () => {
    const bytes = enc.encode('event: delta\ndata: {"text":"ok"}\n\n');
    const msgs = feed(Array.from(bytes, (b) => new Uint8Array([b])));
    expect(msgs).toEqual([{ event: 'delta', data: '{"text":"ok"}' }]);
  });

  it('decodes multi-byte UTF-8 characters split across reads', () => {
    const bytes = enc.encode('event: delta\ndata: {"text":"café – 日本"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1; // split inside "é"
    const msgs = feed([bytes.slice(0, cut), bytes.slice(cut, cut + 7), bytes.slice(cut + 7)]);
    expect(JSON.parse(msgs[0].data)).toEqual({ text: 'café – 日本' });
  });

  it('supports CRLF and CR line endings, including CRLF split across reads', () => {
    expect(feed(['event: a\r\ndata: 1\r', '\n\r\nevent: b\rdata: 2\r\r'])).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('joins multi-line data with newlines and ignores comments / unknown fields', () => {
    expect(feed([': keep-alive\nretry: 100\nevent: x\ndata: line1\ndata: line2\nfoo: bar\n\n'])).toEqual([
      { event: 'x', data: 'line1\nline2' },
    ]);
  });

  it('defaults the event name to "message" and strips only one leading space', () => {
    expect(feed(['data:  two spaces\n\n'])).toEqual([{ event: 'message', data: ' two spaces' }]);
  });

  it('does not emit events without data, and resets the name between events', () => {
    expect(feed(['event: ping\n\ndata: x\n\n'])).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('flushes a final event that lacks the trailing blank line at end of stream', () => {
    const p = new SseParser();
    expect(p.push('event: done\ndata: {}')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'done', data: '{}' }]);
  });
});

describe('readAskStream', () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  it('emits typed ask events across chunk boundaries and skips malformed ones', async () => {
    const events: AskEvent[] = [];
    await readAskStream(
      streamOf([
        'event: meta\ndata: {"conversation_id":"c1","user_message_id":"u1"}\n\nevent: del',
        'ta\ndata: {"text":"Hel"}\n\nevent: delta\ndata: {"text":"lo [1]"}\n',
        '\nevent: bogus\ndata: {}\n\nevent: delta\ndata: not-json\n\nevent: reset\ndata: {}\n\n',
      ]),
      (e) => events.push(e),
    );
    expect(events.map((e) => e.event)).toEqual(['meta', 'delta', 'delta', 'reset']);
    expect(events[2]).toEqual({ event: 'delta', data: { text: 'lo [1]' } });
  });
});
