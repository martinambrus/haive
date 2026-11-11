import { eq, sql } from 'drizzle-orm';
import { schema, type Database, type MergeResolveState } from '@haive/database';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { PROJECT_STATE_DIR } from '@haive/shared/project-state';
import { posix } from 'node:path';
import type { KeptFile, KeptFiles } from './set-aside.js';

type DbOrTx = Database | Parameters<Parameters<Database['transaction']>[0]>[0];
export type KeptMetadata = NonNullable<MergeResolveState['keptMetadata']>;

export function keptMetadataOf(kept: KeptFiles): KeptMetadata {
  const metadata: KeptMetadata = {};
  for (const [path, { bytes, owner, mode, untracked, parents }] of kept) {
    const entry: KeptMetadata[string] = {};
    if (untracked && Buffer.isBuffer(bytes) && owner && mode !== undefined) {
      entry.owner = owner;
      entry.mode = mode;
    }
    if (parents && parents.length > 0) entry.parents = parents;
    if (Object.keys(entry).length > 0) metadata[path] = entry;
  }
  return metadata;
}

export function keptFilesOf(metadata: KeptMetadata): KeptFiles {
  return new Map(
    Object.entries(metadata).map(([path, { owner, mode, parents }]): [string, KeptFile] => [
      path,
      { index: null, bytes: Buffer.alloc(0), untracked: owner !== undefined, owner, mode, parents },
    ]),
  );
}

/** Capture before the judge transaction commits, ahead of any removal. Existing entries win on retry. */
export async function captureProjectionMetadata(
  repoPath: string,
  paths: readonly string[],
  untracked: (path: string) => Promise<boolean>,
): Promise<KeptMetadata> {
  const metadata: KeptMetadata = {};
  for (const path of paths) {
    if (!(await untracked(path))) continue;
    const info = await lstatNoFollow(repoPath, path, { strict: true });
    if (info?.kind !== 'file') continue;
    const { uid, gid, mode } = info.stats;
    const parents: NonNullable<KeptMetadata[string]['parents']> = [];
    if (path.startsWith(`${PROJECT_STATE_DIR}/`)) {
      for (
        let dir = posix.dirname(path);
        dir.length >= PROJECT_STATE_DIR.length;
        dir = posix.dirname(dir)
      ) {
        const parent = await lstatNoFollow(repoPath, dir, { strict: true });
        if (parent?.kind === 'directory')
          parents.push({
            path: dir,
            owner: { uid: parent.stats.uid, gid: parent.stats.gid },
            mode: parent.stats.mode & 0o7777,
          });
      }
    }
    metadata[path] = {
      owner: { uid, gid },
      mode: mode & 0o7777,
      ...(parents.length ? { parents } : {}),
    };
  }
  return metadata;
}

/** No bytes or new journal: refresh/Save/Pull have no merge step in which to keep this map. */
export async function rememberKeptMetadata(
  db: DbOrTx,
  repositoryId: string,
  repoPath: string,
  metadata: KeptMetadata,
): Promise<void> {
  if (Object.keys(metadata).length === 0) return;
  const serialized = JSON.stringify({ [repoPath]: metadata });
  await db.execute(sql`
    INSERT INTO project_state_outbox (repository_id, kept_metadata)
    VALUES (${repositoryId}, ${serialized}::jsonb)
    ON CONFLICT (repository_id) DO UPDATE SET
      kept_metadata = coalesce(project_state_outbox.kept_metadata, '{}'::jsonb) ||
        jsonb_build_object(${repoPath}::text, ${JSON.stringify(metadata)}::jsonb ||
          coalesce(project_state_outbox.kept_metadata -> ${repoPath}::text, '{}'::jsonb)),
      updated_at = now()
  `);
}

/** The snapshot is consumed only if it is still the one restored; a concurrent capture stays owed. */
export async function restorePendingKeptMetadata(
  db: Database,
  repositoryId: string,
  repoPath: string,
  restore: (repoPath: string, kept: KeptFiles) => Promise<boolean>,
): Promise<boolean> {
  const [row] = await db
    .select({ kept: schema.projectStateOutbox.keptMetadata })
    .from(schema.projectStateOutbox)
    .where(eq(schema.projectStateOutbox.repositoryId, repositoryId))
    .limit(1);
  const metadata = row?.kept?.[repoPath];
  if (!metadata) return true;
  if (!(await restore(repoPath, keptFilesOf(metadata)))) return false;
  await db.execute(sql`
    UPDATE project_state_outbox SET
      kept_metadata = nullif(kept_metadata - ${repoPath}::text, '{}'::jsonb), updated_at = now()
    WHERE repository_id = ${repositoryId} AND kept_metadata -> ${repoPath}::text = ${JSON.stringify(metadata)}::jsonb
  `);
  return true;
}
