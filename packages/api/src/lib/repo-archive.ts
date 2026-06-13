import { stat } from 'node:fs/promises';
import { ZipArchive } from 'archiver';
import type { Readable } from 'node:stream';
import { HttpError } from '../context.js';

export interface RepoArchiveResult {
  stream: Readable;
  filename: string;
}

/**
 * Streams the repository working tree at `root` as a zip. The whole tree is
 * packed verbatim, including the `.git` directory and other dotfiles —
 * archiver's `.directory()` sets `dot: true` internally. Contents are nested
 * under a single top-level folder named after the repo so extraction yields
 * one directory rather than scattering files into the user's cwd.
 */
export async function createRepoArchiveStream(
  root: string,
  repoName: string,
): Promise<RepoArchiveResult> {
  let st;
  try {
    st = await stat(root);
  } catch {
    throw new HttpError(404, 'Repository root not found');
  }
  if (!st.isDirectory()) {
    throw new HttpError(409, 'Repository root is not a directory');
  }

  const safe = repoName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';

  // archiver v8 dropped the `archiver('zip')` factory in favour of the format
  // classes; ZipArchive extends the Transform-based Archiver core.
  const archive = new ZipArchive({ zlib: { level: 6 } });
  // archiver emits 'warning' for non-fatal issues (e.g. a file vanishing
  // mid-pack). Only ENOENT is benign; anything else aborts the stream so the
  // client sees a failed download rather than a silently-truncated zip.
  archive.on('warning', (err) => {
    if (err.code !== 'ENOENT') archive.destroy(err);
  });
  archive.directory(root, safe);
  // finalize() is async; route a failure into the stream's error path instead
  // of leaving an unhandled rejection.
  archive.finalize().catch((err: Error) => archive.destroy(err));

  return { stream: archive, filename: `${safe}.zip` };
}
