// A fixed buffer bounds memory even when a peer sends millions of tiny chunks.
export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  tooLarge: () => Error,
) {
  const reader = stream.getReader();
  let buffer = new Uint8Array(Math.min(limit, 4096));
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return buffer.slice(0, size);
      if (value.byteLength > limit - size) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      if (size + value.byteLength > buffer.byteLength) {
        const next = Math.min(limit, Math.max(size + value.byteLength, buffer.byteLength * 2));
        const grown = new Uint8Array(next);
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
