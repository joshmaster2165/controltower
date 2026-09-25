/**
 * Read an upstream body into memory, up to `max` bytes. Past that it stops reading, releases the
 * connection and returns undefined, so one oversized reply can't exhaust the server's memory.
 */
export async function readCapped(body: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void }, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += b.length;
    if (size > max) {
      body.destroy?.();
      return undefined;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
