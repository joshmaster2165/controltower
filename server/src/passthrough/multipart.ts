/**
 * Just enough multipart/form-data for uploads passed through to a provider (image edits, audio
 * transcriptions): read the text fields, change one (the model name), and put the body back together
 * byte for byte otherwise. Files are never decoded or copied more than once.
 */

export interface Part {
  /** The part's header block as sent, without the blank line after it. */
  head: string;
  name: string | undefined;
  filename: string | undefined;
  data: Buffer;
}

export function boundaryOf(contentType: string | undefined): string | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return m ? (m[1] ?? m[2]) : undefined;
}

/** The parts of a multipart body; undefined when it isn't one. */
export function parseMultipart(body: Buffer, boundary: string): Part[] | undefined {
  const delim = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let at = body.indexOf(delim);
  if (at < 0) return undefined;
  for (;;) {
    at += delim.length;
    // "--" after a delimiter ends the body.
    if (body[at] === 0x2d && body[at + 1] === 0x2d) return parts;
    if (body[at] === 0x0d && body[at + 1] === 0x0a) at += 2;
    const headEnd = body.indexOf('\r\n\r\n', at);
    if (headEnd < 0) return undefined;
    const head = body.subarray(at, headEnd).toString('utf8');
    const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), headEnd + 4);
    if (next < 0) return undefined;
    const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
    parts.push({
      head,
      name: /\bname="([^"]*)"/i.exec(disp)?.[1],
      filename: /\bfilename="([^"]*)"/i.exec(disp)?.[1],
      data: body.subarray(headEnd + 4, next),
    });
    at = next + 2;
  }
}

/** A text field's value (the first part of that name that isn't a file). */
export function field(parts: Part[], name: string): string | undefined {
  const p = parts.find((x) => x.name === name && x.filename === undefined);
  return p ? p.data.toString('utf8') : undefined;
}

/** Put the parts back together, with the given text fields changed. */
export function buildMultipart(parts: Part[], boundary: string, set: Record<string, string> = {}): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    const value = p.name !== undefined && p.filename === undefined && p.name in set ? Buffer.from(set[p.name]!) : p.data;
    out.push(Buffer.from(`--${boundary}\r\n${p.head}\r\n\r\n`), value, Buffer.from('\r\n'));
  }
  out.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(out);
}
