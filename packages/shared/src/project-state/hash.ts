import { createHash } from 'node:crypto';

const NUL = String.fromCharCode(0);

/** A repository's object format (`extensions.objectFormat`), sha1 unless it was created otherwise. */
export type GitObjectFormat = 'sha1' | 'sha256';

/** The id git gives a file holding `content`: `git hash-object` without reading the tree. A caller
 *  that compares against ids read FROM a repository passes that repository's format, since the two
 *  formats never agree on one file. MEASURED against git 2.54 in both. */
export function gitBlobId(content: string, format: GitObjectFormat = 'sha1'): string {
  const body = Buffer.from(content, 'utf8');
  return createHash(format).update(`blob ${body.length}${NUL}`).update(body).digest('hex');
}

/** One hash of the record's files by their blob ids, so a sync can tell an unchanged record
 *  without reading it. Paths are relative to the record's directory. */
export function projectStateHash(blobIds: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const rel of [...blobIds.keys()].sort()) hash.update(`${rel}${NUL}${blobIds.get(rel)}\n`);
  return hash.digest('hex');
}
