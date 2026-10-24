import path from 'node:path';
import {
  and,
  eq,
  getTableName,
  gt,
  gte,
  inArray,
  lt,
  notExists,
  notInArray,
  or,
} from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { lstatNoFollow, readdirNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { splitUploadPath } from './worktree-paths.js';

const log = logger.child({ module: 'upload-reaper' });

const IDLE_MS = 24 * 60 * 60 * 1000;
const REAP_RETRY_MS = IDLE_MS;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const UPLOADS_DIR = '_uploads';
const BATCH = 100;
const MAX_ORPHAN_FAILURES = 1000;
const orphanFailures = new Map<string, { root: string; rel: string; code: string | undefined }>();
const ENDED_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const;

// Group 1 of every shape built from it is the session id.
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const ARCHIVE_PARTIAL = new RegExp(`^${UUID}\\.(zip|tar|tar\\.gz)\\.partial$`);
const ARCHIVE_FINISHED = new RegExp(`^${UUID}\\.(zip|tar|tar\\.gz)$`);
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
  // A reaping row names its partial or, for an ended dump, the finished file; null for the others.
  finished: RegExp | null;
  // A bundle's final path belongs to the bundle; the others' final file sits beside the partial.
  finalBesidePartial: boolean;
}

const KINDS: UploadKind[] = [
  {
    table: schema.repoUploads,
    pathColumn: schema.repoUploads.archivePath,
    root: repoRoot,
    partial: ARCHIVE_PARTIAL,
    finished: null,
    finalBesidePartial: true,
  },
  {
    table: schema.dbUploads,
    pathColumn: schema.dbUploads.dumpPath,
    root: repoRoot,
    partial: DUMP_PARTIAL,
    finished: DUMP_FILE,
    finalBesidePartial: true,
  },
  {
    table: schema.customBundleUploads,
    pathColumn: schema.customBundleUploads.archivePath,
    root: bundleRoot,
    partial: ARCHIVE_PARTIAL,
    finished: null,
    finalBesidePartial: false,
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

function finalRelOf(partialRel: string): string {
  return partialRel.replace(/\.partial$/, '');
}

async function removeFile(root: string, rel: string): Promise<boolean> {
  const info = await lstatNoFollow(root, rel);
  if (info === null || (info.kind !== 'file' && info.kind !== 'symlink')) return false;
  return removeNoFollow(root, rel);
}

// A complete parks its session in 'completing'; one that died there is claimed too.
async function claimIdleSessions(db: Database, kind: UploadKind, cutoff: Date): Promise<void> {
  const table = kind.table;
  await db
    .update(table)
    .set({ status: 'reaping', updatedAt: new Date() })
    .where(and(inArray(table.status, ['uploading', 'completing']), lt(table.updatedAt, cutoff)));
}

// A failed or cancelled task can be retried, so a dump stays a day after its last task changed;
// one no task names stays a day after the upload, since task creation follows it.
async function claimEndedDumps(db: Database, cutoff: Date): Promise<void> {
  const dumps = await db
    .select({
      id: schema.dbUploads.id,
      userId: schema.dbUploads.userId,
      stored: schema.dbUploads.dumpPath,
    })
    .from(schema.dbUploads)
    .where(and(eq(schema.dbUploads.status, 'complete'), lt(schema.dbUploads.updatedAt, cutoff)));
  if (dumps.length === 0) return;

  const tasks: { dumpId: string | null; status: string; updatedAt: Date }[] = [];
  for (let i = 0; i < dumps.length; i += BATCH) {
    tasks.push(
      ...(await db
        .select({
          dumpId: schema.tasks.dbUploadId,
          status: schema.tasks.status,
          updatedAt: schema.tasks.updatedAt,
        })
        .from(schema.tasks)
        .where(
          inArray(
            schema.tasks.dbUploadId,
            dumps.slice(i, i + BATCH).map((dump) => dump.id),
          ),
        )),
    );
  }
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

  for (const dump of dumps) {
    if (pinned.has(dump.id)) continue;
    try {
      if (ownedRel(repoRoot(), dump.userId, dump.stored, DUMP_FILE) === null) {
        log.warn({ stored: dump.stored }, 'completed dump names a path that is not its own file');
        continue;
      }
      await claimDump(db, dump.id, cutoff);
    } catch (err) {
      log.warn({ err, dumpId: dump.id }, 'ended dump was not claimed');
    }
  }
}

// A row stays 'reaping' while any file stays; every pass finishes those rows, whatever their age.
async function finishReaping(
  db: Database,
  kind: UploadKind,
): Promise<{ sessions: number; dumps: number }> {
  const table = kind.table;
  const rows = await db
    .select({
      id: table.id,
      userId: table.userId,
      stored: kind.pathColumn,
      updatedAt: table.updatedAt,
    })
    .from(table)
    .where(eq(table.status, 'reaping'));
  const done = { sessions: 0, dumps: 0 };
  for (const row of rows) {
    try {
      const own = (shape: RegExp) => ownedRel(kind.root(), row.userId, row.stored, shape);
      const partialRel = own(kind.partial);
      const rel = partialRel ?? (kind.finished === null ? null : own(kind.finished));
      if (rel === null) {
        log.warn({ stored: row.stored }, 'reaping upload names a path that is not its own file');
      }
      const files = rel === null ? [] : [rel];
      if (partialRel !== null && kind.finalBesidePartial) files.push(finalRelOf(partialRel));
      let gone = true;
      let lastErr: unknown;
      for (const file of files) {
        try {
          await removeFile(kind.root(), file);
        } catch (err) {
          gone = false;
          lastErr = err;
          log.warn({ err, rel: file }, 'reaping upload file was not removed');
        }
      }
      if (!gone) {
        if (row.updatedAt.getTime() < Date.now() - REAP_RETRY_MS) {
          const [parked] = await db
            .update(table)
            .set({ status: 'reap_failed', updatedAt: new Date() })
            .where(and(eq(table.id, row.id), eq(table.status, 'reaping')))
            .returning({ id: table.id });
          if (parked !== undefined) {
            log.error(
              { err: lastErr, id: row.id, table: getTableName(table), stored: row.stored },
              'upload removal kept failing for a day; the row is parked as reap_failed',
            );
          }
        }
        continue;
      }
      const [cancelled] = await db
        .update(table)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(table.id, row.id), eq(table.status, 'reaping')))
        .returning({ id: table.id });
      if (cancelled === undefined) continue;
      if (rel !== null && partialRel === null) done.dumps += 1;
      else done.sessions += 1;
    } catch (err) {
      log.warn({ err, id: row.id }, 'reaping upload was not finished');
    }
  }
  return done;
}

// A row turns cancelled only once every file of it is gone. A task that names a cancelled dump
// keeps the row: deleting it would null the task's link and a Retry would skip the restore.
async function deleteCancelledSessions(
  db: Database,
  kind: UploadKind,
  cutoff: Date,
): Promise<void> {
  const table = kind.table;
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.status, 'cancelled'), lt(table.updatedAt, cutoff)));
  for (let i = 0; i < rows.length; i += BATCH) {
    let ids = rows.slice(i, i + BATCH).map((row) => row.id);
    if (table === schema.dbUploads) {
      const named = await db
        .select({ dumpId: schema.tasks.dbUploadId })
        .from(schema.tasks)
        .where(inArray(schema.tasks.dbUploadId, ids));
      const kept = new Set(named.map((task) => task.dumpId));
      ids = ids.filter((id) => !kept.has(id));
    }
    if (ids.length === 0) continue;
    await db.delete(table).where(and(inArray(table.id, ids), eq(table.status, 'cancelled')));
  }
}

async function claimDump(db: Database, dumpId: string, cutoff: Date): Promise<boolean> {
  const keptByTask = db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.dbUploadId, dumpId),
        or(
          notInArray(schema.tasks.status, [...ENDED_TASK_STATUSES]),
          gte(schema.tasks.updatedAt, cutoff),
        ),
      ),
    );
  // Lock the row first: an uncommitted task insert holds KEY SHARE on it, which the UPDATE does
  // not wait for, and the statement after the lock sees that task once it commits.
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ id: schema.dbUploads.id })
      .from(schema.dbUploads)
      .where(and(eq(schema.dbUploads.id, dumpId), eq(schema.dbUploads.status, 'complete')))
      .for('update');
    if (!locked) return false;
    const [taken] = await tx
      .update(schema.dbUploads)
      .set({ status: 'reaping', updatedAt: new Date() })
      .where(
        and(
          eq(schema.dbUploads.id, dumpId),
          eq(schema.dbUploads.status, 'complete'),
          notExists(keptByTask),
        ),
      )
      .returning({ id: schema.dbUploads.id });
    return taken !== undefined;
  });
}

// A complete claims its row, which stamps it, before it moves the partial, so a row touched inside
// the window protects the partial of its session whatever its status or path.
async function recentSessions(db: Database, ids: string[], cutoff: Date): Promise<Set<string>> {
  const recent = new Set<string>();
  for (const kind of KINDS) {
    const rows = await db
      .select({ id: kind.table.id })
      .from(kind.table)
      .where(
        and(
          inArray(kind.table.id, ids),
          or(gt(kind.table.updatedAt, cutoff), eq(kind.table.status, 'reap_failed')),
        ),
      );
    for (const row of rows) recent.add(row.id);
  }
  return recent;
}

// The ids of a finished archive's repositories that still need it: only a cloning one. An
// id no repository carries may be a legacy archive named by its upload session, so it stays while
// its owner has a repository still cloning.
async function liveRepositories(
  db: Database,
  ids: string[],
  owner: string,
  cloningOwners: () => Promise<Set<string>>,
): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.repositories.id, status: schema.repositories.status })
    .from(schema.repositories)
    .where(inArray(schema.repositories.id, ids));
  const known = new Set(rows.map((row) => row.id));
  const live = new Set(rows.filter((row) => row.status === 'cloning').map((row) => row.id));
  if (known.size < ids.length && (await cloningOwners()).has(owner)) {
    for (const id of ids) if (!known.has(id)) live.add(id);
  }
  return live;
}

async function forgetGoneOrphanFailures(): Promise<void> {
  for (const [key, { root, rel }] of orphanFailures) {
    try {
      if ((await lstatNoFollow(root, rel, { strict: true })) === null) orphanFailures.delete(key);
    } catch {
      // An unreadable path may still hold the file whose removal failed.
    }
  }
}

function logOrphanFailure(root: string, rel: string, err: unknown): void {
  const key = path.join(root, rel);
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const previous = orphanFailures.get(key);
  if (previous === undefined || previous.code !== code) {
    log.warn({ err, root, rel }, 'orphan upload file was not removed');
  } else {
    log.debug({ err, root, rel }, 'orphan upload file was not removed');
  }
  if (previous !== undefined || orphanFailures.size < MAX_ORPHAN_FAILURES) {
    orphanFailures.set(key, { root, rel, code });
  }
}

async function reapOrphanPartials(
  db: Database,
  root: string,
  shapes: RegExp[],
  pass: string,
  alsoKept?: (ids: string[], owner: string) => Promise<Set<string>>,
): Promise<number> {
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
      const kept = alsoKept
        ? await alsoKept(
            batch.map((file) => file.session),
            owner.name,
          )
        : null;
      for (const { rel, session } of batch) {
        if (recent.has(session) || kept?.has(session)) continue;
        try {
          if (await removeFile(root, rel)) {
            removed += 1;
            log.debug({ rel, pass }, 'orphan upload file removed');
          }
          orphanFailures.delete(path.join(root, rel));
        } catch (err) {
          logOrphanFailure(root, rel, err);
        }
      }
    }
    const left = await readdirNoFollow(root, dirRel);
    const own = await lstatNoFollow(root, dirRel);
    if (left?.length === 0 && own !== null && own.stats.mtimeMs < cutoff.getTime()) {
      await removeNoFollow(root, dirRel).catch(() => undefined);
    }
  }
  return removed;
}

/** One reaper pass: claim the idle and the ended, finish what is reaping, sweep orphan partials. */
export async function reapAbandonedUploads(db: Database): Promise<UploadReapResult> {
  await forgetGoneOrphanFailures();
  const cutoff = new Date(Date.now() - IDLE_MS);
  const result: UploadReapResult = { sessions: 0, dumps: 0, orphans: 0 };
  const guarded = async <T>(what: string, run: () => Promise<T>, skipped: T): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      log.warn({ err }, `upload reaper skipped ${what}`);
      return skipped;
    }
  };
  for (const kind of KINDS) {
    await guarded('an idle-session pass', () => claimIdleSessions(db, kind, cutoff), undefined);
  }
  await guarded('the ended-dump pass', () => claimEndedDumps(db, cutoff), undefined);
  for (const kind of KINDS) {
    const done = await guarded('a cleanup pass', () => finishReaping(db, kind), {
      sessions: 0,
      dumps: 0,
    });
    result.sessions += done.sessions;
    result.dumps += done.dumps;
  }
  for (const kind of KINDS) {
    await guarded(
      'a cancelled-row pass',
      () => deleteCancelledSessions(db, kind, cutoff),
      undefined,
    );
  }
  result.orphans += await guarded(
    'the repository file pass',
    () => reapOrphanPartials(db, repoRoot(), [ARCHIVE_PARTIAL, DUMP_PARTIAL], 'repository'),
    0,
  );
  let cloning: Promise<Set<string>> | null = null;
  const cloningOwners = () =>
    (cloning ??= db
      .select({ userId: schema.repositories.userId })
      .from(schema.repositories)
      .where(eq(schema.repositories.status, 'cloning'))
      .then((rows) => new Set(rows.map((row) => row.userId))));
  result.orphans += await guarded(
    'the finished archive pass',
    () =>
      reapOrphanPartials(db, repoRoot(), [ARCHIVE_FINISHED], 'finished archive', (ids, owner) =>
        liveRepositories(db, ids, owner, cloningOwners),
      ),
    0,
  );
  result.orphans += await guarded(
    'the finished dump pass',
    () =>
      reapOrphanPartials(db, repoRoot(), [DUMP_FILE], 'finished dump', async (ids) => {
        const rows = await db
          .select({ id: schema.dbUploads.id })
          .from(schema.dbUploads)
          .where(inArray(schema.dbUploads.id, ids));
        return new Set(rows.map((row) => row.id));
      }),
    0,
  );
  result.orphans += await guarded(
    'the bundle file pass',
    () => reapOrphanPartials(db, bundleRoot(), [ARCHIVE_PARTIAL], 'bundle'),
    0,
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
