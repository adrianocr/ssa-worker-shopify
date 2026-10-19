/** Anything with a body stream and headers: a Request or a Response. */
interface HasBody {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Reads a body stream up to `max` bytes. Past the cap it cancels the stream and either returns null
 * ("reject") or the first `max` bytes ("truncate"). Either way at most `max` bytes are buffered.
 */
async function readStream(stream: ReadableStream<Uint8Array>, max: number, overflow: "reject" | "truncate"): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > max) {
      await reader.cancel().catch(() => undefined);
      if (overflow === "reject") return null;
      chunks.push(value.subarray(0, max - total));
      total = max;
      break;
    }
    total += value.byteLength;
    chunks.push(value);
  }
  return concat(chunks, total);
}

/**
 * Reads a request body up to `max` bytes. Returns null when it's larger: a Content-Length over the
 * cap is rejected before any read, and the stream itself is counted chunk by chunk and cancelled
 * once it passes the cap, so a chunked body with no (or a false) Content-Length can't be buffered
 * without limit.
 */
export async function readBodyCapped(request: HasBody, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  return readStream(request.body, max, "reject");
}

/** The first `max` bytes of a body, cancelling the rest. For error bodies that only get logged. */
export async function readBodyPrefix(message: HasBody, max: number): Promise<Uint8Array> {
  if (!message.body) return new Uint8Array(0);
  return (await readStream(message.body, max, "truncate")) ?? new Uint8Array(0);
}
