import { stat } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import tar from 'tar-fs';
import type { Readable } from 'node:stream';
import { HttpError } from '../context.js';

export interface TaskArchiveResult {
  stream: Readable;
  filename: string;
}

export async function createTaskArchiveStream(
  root: string,
  taskId: string,
): Promise<TaskArchiveResult> {
  let st;
  try {
    st = await stat(root);
  } catch {
    throw new HttpError(404, 'Workspace root not found');
  }
  if (!st.isDirectory()) {
    throw new HttpError(409, 'Workspace root is not a directory');
  }

  const pack = tar.pack(root, { dereference: false });
  const gzip = createGzip({ level: 6 });
  pack.on('error', (err: Error) => gzip.destroy(err));
  const stream = pack.pipe(gzip);

  return { stream, filename: `task-${taskId}-source.tar.gz` };
}
