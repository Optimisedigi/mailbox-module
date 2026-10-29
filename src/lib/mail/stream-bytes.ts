const CHUNK_BYTES = 1024 * 1024;

/**
 * Send bytes as a stream, one chunk at a time. A Vercel Function can only
 * return 4.5 MB in one response; streamed responses are not held to that
 * limit. Set no content-length, or the platform may buffer it instead.
 */
export function streamBytes(bytes: Buffer): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + CHUNK_BYTES, bytes.length);
      controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
      offset = end;
    },
  });
}
