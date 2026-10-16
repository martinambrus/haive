import path from 'node:path';
import { and, eq, gt, gte, inArray, isNotNull, lt, notExists, notInArray, or } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { lstatNoFollow, readdirNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { splitUploadPath } from './worktree-paths.js';

const log = logger.child({ module: 'upload-reaper' });

const IDLE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const UPLOADS_DIR = '_uploads';
const BATCH = 100;
const ENDED_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const;

// Group 1 of every shape built from it is the session id.
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ARCHIVE_PARTIAL = new RegExp(`^${UUID}\\.(zip|tar|tar\\.gz)\\.partial$`);
// The extension rule is dumpDiskExtension in the api's db-dumps.ts.
const DUMP_PARTIAL = new RegExp(`^db-${UUID}\\.[a-z0-9.]{1,16}\\.partial$`);
const DUMP_FILE = new RegExp(`^db-${UUID}\\.[a-z0-9.]{1,16}$`);

const repoRoot = () => process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
const bundleRoot = () => process.env.BUNDLE_STORAGE_ROOT ?? '/var/lib/haive/bundles';

type UploadTable =
  typeof schema.repoUploads | typeof schema.dbUploads | typeof schema.customBundleUploads;

interface UploadKind {
  table: UploadTable;
  pathColumn:
    | typeof schema.repoUploads.archivePath
    | typeof schema.dbUploads.dumpPath
    | typeof schema.customBundleUploads.archivePath;
  root: () => string;
  partial: RegExp;
}

const KINDS: UploadKind[] = [
  {
    table: schema.repoUploads,
    pathColumn: schema.repoUploads.archivePath,
    root: repoRoot,
    partial: ARCHIVE_PARTIAL,
  },
  {
    table: schema.dbUploads,
    pathColumn: schema.dbUploads.dumpPath,
    root: repoRoot,
    partial: DUMP_PARTIAL,
  },
  {
    table: schema.customBundleUploads,
    pathColumn: schema.customBundleUploads.archivePath,
    root: bundleRoot,
    partial: ARCHIVE_PARTIAL,
  },
];

export interface UploadReapResult {
  sessions: number;
  dumps: number;
  orphans: number;
}

function ownedRel(root: string, userId: string, stored: string, shape: RegExp): string | null {
  const split = splitUploadPath(root, stored);
  const name = path.basename(stored);
  if (split === null || split.rel !== `${UPLOADS_DIR}/${userId}/${name}` || !shape.test(name)) {
    return null;
  }
  return split.rel;
}

async function removeFile(root: string, rel: string): Promise<boolean> {
  const info = await lstatNoFollow(root, rel);
  if (info === null || (info.kind !== 'file' && info.kind !== 'symlink')) return false;
  return removeNoFollow(root, rel);
}

async function reapIdleSessions(db: Database, kind: UploadKind, cutoff: Date): Promise<number> {
  const table = kind.table;
  // Only a bundle complete parks a session in 'completing'; one that died there is reaped too.
  const claimed = await db
    .update(table)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(inArray(table.status, ['uploading', 'completing']), lt(table.updatedAt, cutoff)))
    .returning({ userId: table.userId, stored: kind.pathColumn });
  for (const row of claimed) {
    try {
      const rel = ownedRel(kind.root(), row.userId, row.stored, kind.partial);
      if (rel === null) {
        log.warn({ stored: row.stored }, 'reaped upload names a path that is not its own partial');
        continue;
      }
      await removeFile(kind.root(), rel);
    } catch (err) {
      log.warn(
        { err, stored: row.stored },
        'reaped upload left its partial; the file pass retries',
      );
    }
  }
  return claimed.length;
}

// A failed or cancelled task can be retried, so a dump stays a day after its last task changed;
// one no task names stays a day after the upload, since task creation follows it.
async function reapEndedDumps(db: Database, cutoff: Date): Promise<number> {
  const dumps = await db
    .select({
      id: schema.dbUploads.id,
      userId: schema.dbUploads.userId,
      stored: schema.dbUploads.dumpPath,
    })
    .from(schema.dbUploads)
    .where(and(eq(schema.dbUploads.status, 'complete'), lt(schema.dbUploads.updatedAt, cutoff)));
  if (dumps.length === 0) return 0;

  const tasks = await db
    .select({
      dumpId: schema.tasks.dbUploadId,
      status: schema.tasks.status,
      updatedAt: schema.tasks.updatedAt,
    })
    .from(schema.tasks)
    .where(isNotNull(schema.tasks.dbUploadId));
  const pinned = new Set<string>();
  for (const task of tasks) {
    if (task.dumpId === null) continue;
    if (
      !(ENDED_TASK_STATUSES as readonly string[]).includes(task.status) ||
      task.updatedAt >= cutoff
    ) {
      pinned.add(task.dumpId);
    }
  }

  let reaped = 0;
  for (const dump of dumps) {
    if (pinned.has(dump.id)) continue;
    try {
      const rel = ownedRel(repoRoot(), dump.userId, dump.stored, DUMP_FILE);
      if (rel === null) {
        log.warn({ stored: dump.stored }, 'completed dump names a path that is not its own file');
        continue;
      }
      const keptByTask = db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.dbUploadId, dump.id),
            or(
              notInArray(schema.tasks.status, [...ENDED_TASK_STATUSES]),
              gte(schema.tasks.updatedAt, cutoff),
            ),
          ),
        );
      // Lock the row first: an uncommitted task insert holds KEY SHARE on it, which the UPDATE does
      // not wait for, and the statement after the lock sees that task once it commits.
      const claimed = await db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: schema.dbUploads.id })
          .from(schema.dbUploads)
          .where(and(eq(schema.dbUploads.id, dump.id), eq(schema.dbUploads.status, 'complete')))
          .for('update');
        if (!locked) return false;
        const [taken] = await tx
          .update(schema.dbUploads)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(
            and(
              eq(schema.dbUploads.id, dump.id),
              eq(schema.dbUploads.status, 'complete'),
              notExists(keptByTask),
            ),
          )
          .returning({ id: schema.dbUploads.id });
        return taken !== undefined;
      });
      if (!claimed) continue;
      reaped += 1;
      await removeFile(repoRoot(), rel);
    } catch (err) {
      log.warn({ err, dumpId: dump.id }, 'ended dump was not fully reaped');
    }
  }
  return reaped;
}

// A complete flips its row to the final path before it moves the partial, so a row touched inside
// the window protects the partial of its session whatever its status or path.
async function recentSessions(db: Database, ids: string[], cutoff: Date): Promise<Set<string>> {
  const recent = new Set<string>();
  for (const kind of KINDS) {
    const rows = await db
      .select({ id: kind.table.id })
      .from(kind.table)
      .where(and(inArray(kind.table.id, ids), gt(kind.table.updatedAt, cutoff)));
    for (const row of rows) recent.add(row.id);
  }
  return recent;
}

async function reapOrphanPartials(db: Database, root: string, shapes: RegExp[]): Promise<number> {
  const owners = await readdirNoFollow(root, UPLOADS_DIR);
  if (owners === null) return 0;
  const cutoff = new Date(Date.now() - IDLE_MS);
  let removed = 0;
  for (const owner of owners) {
    if (!owner.isDirectory()) continue;
    const dirRel = `${UPLOADS_DIR}/${owner.name}`;
    const entries = await readdirNoFollow(root, dirRel);
    if (entries === null) continue;
    const old: { rel: string; session: string }[] = [];
    for (const entry of entries) {
      const session = shapes
        .map((shape) => shape.exec(entry.name)?.[1])
        .find((id) => id !== undefined);
      if (session === undefined) continue;
      const rel = `${dirRel}/${entry.name}`;
      const info = await lstatNoFollow(root, rel);
      if (info !== null && info.stats.mtimeMs < cutoff.getTime()) old.push({ rel, session });
    }
    for (let i = 0; i < old.length; i += BATCH) {
      const batch = old.slice(i, i + BATCH);
      const recent = await recentSessions(
        db,
        batch.map((partial) => partial.session),
        cutoff,
      );
      for (const { rel, session } of batch) {
        if (recent.has(session)) continue;
        try {
          if (await removeFile(root, rel)) removed += 1;
        } catch (err) {
          log.warn({ err, rel }, 'orphan upload partial was not removed');
        }
      }
    }
  }
  return removed;
}

/** One reaper pass: idle sessions, ended dumps, then partials no session names. */
export async function reapAbandonedUploads(db: Database): Promise<UploadReapResult> {
  const cutoff = new Date(Date.now() - IDLE_MS);
  const result: UploadReapResult = { sessions: 0, dumps: 0, orphans: 0 };
  const guarded = async (what: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (err) {
      log.warn({ err }, `upload reaper skipped ${what}`);
      return 0;
    }
  };
  for (const kind of KINDS) {
    result.sessions += await guarded('an idle-session pass', () =>
      reapIdleSessions(db, kind, cutoff),
    );
  }
  result.dumps = await guarded('the ended-dump pass', () => reapEndedDumps(db, cutoff));
  result.orphans += await guarded('the repository file pass', () =>
    reapOrphanPartials(db, repoRoot(), [ARCHIVE_PARTIAL, DUMP_PARTIAL]),
  );
  result.orphans += await guarded('the bundle file pass', () =>
    reapOrphanPartials(db, bundleRoot(), [ARCHIVE_PARTIAL]),
  );
  if (result.sessions + result.dumps + result.orphans > 0) {
    log.info(result, 'abandoned uploads reaped');
  }
  return result;
}

/** Runs a pass now and every 15 minutes; the returned function stops the timer. */
export function startUploadReaper(db: Database): () => void {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await reapAbandonedUploads(db);
    } catch (err) {
      log.warn({ err }, 'upload reap failed');
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
