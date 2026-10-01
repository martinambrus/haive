import { createHash } from 'node:crypto';

const NUL = String.fromCharCode(0);

/** The id git gives a file holding `content`: `git hash-object` without reading the tree. */
export function gitBlobId(content: string): string {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}${NUL}`).update(body).digest('hex');
}

/** One hash of the record's files by their blob ids, so a sync can tell an unchanged record
 *  without reading it. Paths are relative to the record's directory. */
export function projectStateHash(blobIds: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const rel of [...blobIds.keys()].sort()) hash.update(`${rel}${NUL}${blobIds.get(rel)}\n`);
  return hash.digest('hex');
}
