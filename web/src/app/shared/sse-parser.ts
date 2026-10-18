/** One server-sent event. */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental parser for `text/event-stream` bodies read with `fetch()` + a stream reader.
 * Feed it raw byte chunks (or strings) as they arrive; it returns every event completed by
 * that chunk and buffers partial lines/events (including split UTF-8 sequences and a `\r\n`
 * split across reads) for the next call.
 */
export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private eventName = '';
  private dataLines: string[] = [];
  private lastId: string | undefined;

  push(chunk: Uint8Array | string): SseMessage[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** The stream ended: flush whatever is complete (a final event without a blank line too). */
  end(): SseMessage[] {
    this.buffer += this.decoder.decode();
    const out = this.drain(true);
    if (this.buffer) {
      this.processLine(this.buffer, out);
      this.buffer = '';
    }
    this.dispatch(out);
    return out;
  }

  private drain(final: boolean): SseMessage[] {
    const out: SseMessage[] = [];
    const re = /\r\n|\n|\r/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buffer)) !== null) {
      // A lone trailing '\r' may be the first half of '\r\n' arriving in the next chunk.
      if (m[0] === '\r' && m.index === this.buffer.length - 1 && !final) break;
      this.processLine(this.buffer.slice(start, m.index), out);
      start = m.index + m[0].length;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  private processLine(line: string, out: SseMessage[]): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventName = value;
        break;
      case 'data':
        this.dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\u0000')) this.lastId = value;
        break;
      default:
        break; // `retry` and unknown fields are ignored
    }
  }

  private dispatch(out: SseMessage[]): void {
    if (this.dataLines.length) {
      const msg: SseMessage = { event: this.eventName || 'message', data: this.dataLines.join('\n') };
      if (this.lastId !== undefined) msg.id = this.lastId;
      out.push(msg);
    }
    this.eventName = '';
    this.dataLines = [];
  }
}
