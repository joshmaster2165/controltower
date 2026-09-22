/**
 * Byte-level SSE frame splitter. Frames are delimited by a blank line; we
 * never re-encode text, only find boundaries. At most one partial frame is
 * buffered (capped) so a misbehaving upstream cannot grow memory.
 */
const MAX_PARTIAL = 1024 * 1024;

export interface SseFrame {
  raw: Uint8Array;
  /** Concatenated `data:` payload (lines joined with \n). Empty for comments. */
  data: string;
  event: string | undefined;
}

export class SseParser {
  private buf: Uint8Array = new Uint8Array(0);
  private dec = new TextDecoder();

  /** Feed a chunk; returns complete frames (raw bytes + parsed data). */
  push(chunk: Uint8Array): SseFrame[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    const out: SseFrame[] = [];
    let start = 0;
    for (let i = 0; i < merged.length - 1; i++) {
      // \n\n or \r\n\r\n
      if (merged[i] === 0x0a && merged[i + 1] === 0x0a) {
        out.push(this.frame(merged.subarray(start, i + 2)));
        start = i + 2;
        i += 1;
      } else if (i + 3 < merged.length && merged[i] === 0x0d && merged[i + 1] === 0x0a && merged[i + 2] === 0x0d && merged[i + 3] === 0x0a) {
        out.push(this.frame(merged.subarray(start, i + 4)));
        start = i + 4;
        i += 3;
      }
    }
    this.buf = merged.slice(start);
    if (this.buf.length > MAX_PARTIAL) {
      this.buf = new Uint8Array(0);
      throw new Error('SSE frame exceeds 1 MB');
    }
    return out;
  }

  /** Flush any trailing partial frame (some upstreams omit the final blank line). */
  end(): SseFrame[] {
    if (this.buf.length === 0) return [];
    const f = this.frame(this.buf);
    this.buf = new Uint8Array(0);
    return f.data ? [f] : [];
  }

  private frame(raw: Uint8Array): SseFrame {
    const text = this.dec.decode(raw);
    let event: string | undefined;
    const data: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
    return { raw, data: data.join('\n'), event };
  }
}
