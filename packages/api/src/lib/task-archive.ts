import { stat } from 'node:fs/promises';
import { ZipArchive } from 'archiver';
import type { Readable } from 'node:stream';
import { HttpError } from '../context.js';

export interface TaskArchiveResult {
  stream: Readable;
  filename: string;
}

/**
 * Streams the task workspace at `root` as a zip — the same format the
 * repositories page download produces. The whole tree is packed verbatim,
 * including dotfiles (archiver's `.directory()` sets `dot: true` internally).
 * Contents are nested under a single top-level folder so extraction yields one
 * directory rather than scattering files into the user's cwd.
 */
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

  const name = `task-${taskId}-source`;

  // archiver v8 dropped the `archiver('zip')` factory in favour of the format
  // classes; ZipArchive extends the Transform-based Archiver core.
  const archive = new ZipArchive({ zlib: { level: 6 } });
  // archiver emits 'warning' for non-fatal issues (e.g. a file vanishing
  // mid-pack). Only ENOENT is benign; anything else aborts the stream so the
  // client sees a failed download rather than a silently-truncated zip.
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') archive.destroy(err);
  });
  archive.directory(root, name);
  // finalize() is async; route a failure into the stream's error path instead
  // of leaving an unhandled rejection.
  archive.finalize().catch((err: Error) => archive.destroy(err));

  return { stream: archive, filename: `${name}.zip` };
}
