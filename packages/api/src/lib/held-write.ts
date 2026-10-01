import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';

/** Write a request body through a descriptor the caller holds, chunk by chunk at explicit
 *  positions, and leave it open. A write stream built on a FileHandle closes it when it ends, and
 *  with `autoClose: false` keeps a reference that makes `close()` hang, so a caller removing the
 *  file by its inode could not keep that inode pinned. Throws `tooLarge()` before writing past
 *  `maxBytes`. Returns the bytes written, the first at file offset `start`. */
export async function writeBodyToHeld(
  body: ReadableStream<Uint8Array>,
  fh: FileHandle,
  maxBytes: number,
  tooLarge: () => Error,
  start = 0,
): Promise<number> {
  let total = 0;
  for await (const chunk of Readable.fromWeb(body as never) as AsyncIterable<Uint8Array>) {
    if (total + chunk.byteLength > maxBytes) throw tooLarge();
    let written = 0;
    while (written < chunk.byteLength) {
      const { bytesWritten } = await fh.write(
        chunk,
        written,
        chunk.byteLength - written,
        start + total + written,
      );
      written += bytesWritten;
    }
    total += chunk.byteLength;
  }
  return total;
}
