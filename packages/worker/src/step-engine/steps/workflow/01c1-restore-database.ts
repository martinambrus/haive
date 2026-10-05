import { eq } from 'drizzle-orm';
import type { FormSchema } from '@haive/shared';
import { schema, initializeTaskDatabaseState } from '@haive/database';
import { databaseSnapshotRel } from '@haive/shared/database-snapshot-files';
import { readTextNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { splitUploadPath, workspaceAnchor } from '../../../repo/worktree-paths.js';
import { ReopenStepFormError, type StepDefinition } from '../../step-definition.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { ddevEnvStep } from './01c-ddev-env.js';
import { parseDdevConfig } from '../_ddev-config.js';
import {
  ddevCountTables,
  ddevConfigOmitsDatabase,
  ddevExec,
  ddevImportDb,
  ddevSnapshot,
  ddevImportSnapshotName,
  sniffDumpFormat,
  type DumpImportFormat,
} from '../../../sandbox/ddev-runner.js';
import { ensureDdevWithProgress, withDdevProgress } from './_app-runtime.js';
import {
  verifyDatabaseSnapshotFile,
  withSnapshotStep,
  offerDatabaseRestore,
  sweepDatabaseSnapshots,
} from '../../../repo/database-snapshots.js';

import { importDdevDatabaseSnapshot } from '../../../sandbox/ddev-database-import.js';

const REPO_STORAGE_ROOT = process.env.REPO_STORAGE_ROOT ?? '/var/lib/haive/repos';
function ddevConfigRef(workspace: string) {
  const { anchor, prefix } = workspaceAnchor(workspace);
  return { anchor, rel: `${prefix}.ddev/config.yaml` };
}
interface RestoreDetect {
  repoSubpath: string | null;
  workspace: string | null;
  dbUploadId: string | null;
  dumpWorkerPath: string | null;
  dumpRunnerPath: string | null;
  databaseSnapshotId: string | null;
  snapshotEngine: string | null;
  snapshotRevision?: number;
  checkpoint?: {
    id: string;
    sourceTaskId: string | null;
    sourceTaskTitle: string;
    createdAt: Date | string;
    engine: string;
    engineVersion: string | null;
  };
}

export function databaseRestoreForm(d: RestoreDetect): FormSchema | null {
  if (d.dbUploadId || !d.databaseSnapshotId || !d.checkpoint) return null;
  const c = d.checkpoint;
  return {
    title: 'Restore project database',
    description: `This project has a saved database checkpoint. Restoring replaces this task’s current DDEV database.\n\nSaved ${new Date(c.createdAt).toISOString()} · ${c.engine}${c.engineVersion ? ` ${c.engineVersion}` : ''}`,
    autoSubmit: false,
    fields: [
      {
        id: 'sourceTask',
        type: 'note',
        label: 'Checkpoint saved by',
        body: c.sourceTaskTitle,
      },
      {
        id: 'action',
        type: 'select',
        label: 'Database checkpoint',
        required: true,
        default: 'skip',
        options: [
          { value: 'skip', label: 'Continue without restoring a checkpoint' },
          { value: `restore:${c.id}`, label: 'Restore this saved database checkpoint' },
        ],
      },
    ],
    submitLabel: 'Continue',
  };
}
export const restoreDatabaseStep: StepDefinition<RestoreDetect, { imported: boolean }> = {
  needsRuntime: 'ddev',
  metadata: {
    id: '01c1-restore-database',
    workflowType: 'workflow',
    index: 1.65,
    title: 'Restore project database',
    description: 'Restore the selected saved database or uploaded dump after DDEV startup.',
    requiresCli: false,
    alwaysWaitForUser: true,
  },
  async shouldRun(ctx) {
    const task = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
    if (!task) return false;
    const state = await ctx.db.query.taskDatabaseStates.findFirst({
      where: eq(schema.taskDatabaseStates.taskId, ctx.taskId),
    });
    const pendingSource = Boolean(state?.sourceSnapshotId && !state.importedAt);
    // Share startup eligibility: an upload alone must not start DDEV in a
    // non-DDEV workflow. An explicitly selected saved database must not be ignored.
    if (!(await ddevEnvStep.shouldRun!(ctx))) {
      if (pendingSource)
        throw new Error(
          'The selected saved database requires a DDEV workspace. Choose DDEV in the declared dependencies before continuing.',
        );
      return false;
    }
    if (task.dbUploadId) {
      const upload = await ctx.db.query.dbUploads.findFirst({
        where: eq(schema.dbUploads.id, task.dbUploadId),
      });
      return upload?.status === 'complete';
    }
    if (pendingSource) return true;
    if (state?.importedAt || !task.repositoryId) return false;
    const head = await ctx.db.query.repositoryDatabaseStates.findFirst({
      where: eq(schema.repositoryDatabaseStates.repositoryId, task.repositoryId),
    });
    if (!head?.snapshotId) return false;
    const snapshot = await ctx.db.query.databaseSnapshots.findFirst({
      where: eq(schema.databaseSnapshots.id, head.snapshotId),
    });
    return (
      snapshot?.status === 'ready' &&
      snapshot.repositoryId === task.repositoryId &&
      snapshot.userId === task.userId
    );
  },
  async detect(ctx) {
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const repoSubpath = ws?.repoSubpath ?? null;
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { id: true, dbUploadId: true, repositoryId: true, userId: true },
    });

    let dbUploadId: string | null = null;
    let dumpWorkerPath: string | null = null;
    let dumpRunnerPath: string | null = null;
    let databaseSnapshotId: string | null = null;
    let snapshotEngine: string | null = null;
    if (task?.dbUploadId) {
      const dump = await ctx.db.query.dbUploads.findFirst({
        where: eq(schema.dbUploads.id, task.dbUploadId),
        columns: { id: true, dumpPath: true, status: true },
      });
      if (dump?.dumpPath && dump.status === 'complete') {
        dbUploadId = dump.id;
        dumpWorkerPath = dump.dumpPath;
        // The dump lives in the haive_repos volume (_uploads/...); inside the
        // runner that volume is mounted at /repos, so translate the worker path.
        const upload = splitUploadPath(REPO_STORAGE_ROOT, dump.dumpPath);
        if (upload) dumpRunnerPath = `/repos/${upload.rel}`;
      }
    }

    let checkpoint: RestoreDetect['checkpoint'];
    let snapshotRevision: number | undefined;
    if (task?.repositoryId) {
      await initializeTaskDatabaseState(ctx.db, task);
      if (!task.dbUploadId) {
        const epoch = (await ctx.db.query.tasks.findFirst({
          where: eq(schema.tasks.id, ctx.taskId),
        }))!.orchestrationEpoch;
        const offered = await offerDatabaseRestore(ctx, epoch);
        if (offered) {
          checkpoint = offered.snapshot;
          snapshotRevision = offered.revision;
          databaseSnapshotId = offered.snapshot.id;
          snapshotEngine = offered.snapshot.engine;
          dumpWorkerPath = `${REPO_STORAGE_ROOT}/${databaseSnapshotRel(offered.snapshot)}`;
          // The runner has already started; its mounts cannot change. Import streams
          // this held file through stdin into that running runner.
          dumpRunnerPath = null;
        }
      }
    }

    return {
      repoSubpath,
      workspace: ws?.workspace ?? null,
      dbUploadId,
      dumpWorkerPath,
      dumpRunnerPath,
      databaseSnapshotId,
      snapshotEngine,
      checkpoint,
      snapshotRevision,
    };
  },
  form: (_ctx, d) => databaseRestoreForm(d),
  async apply(ctx, args) {
    const d = args.detected;
    const importEpoch = d.databaseSnapshotId
      ? (await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) }))
          ?.orchestrationEpoch
      : undefined;
    if (d.databaseSnapshotId && !d.dbUploadId) {
      const state = await ctx.db.query.taskDatabaseStates.findFirst({
        where: eq(schema.taskDatabaseStates.taskId, ctx.taskId),
      });
      if (state?.importedAt) return { imported: false };
      if (importEpoch === undefined) throw new Error('The task is unavailable');
      if (args.formValues.action === 'skip') {
        await withSnapshotStep(ctx, importEpoch, async (tx) => {
          await tx
            .update(schema.taskDatabaseStates)
            .set({ sourceSnapshotId: null })
            .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId));
        });
        await sweepDatabaseSnapshots(ctx.db);
        return { imported: false };
      }
      if (
        args.formValues.action !== `restore:${d.databaseSnapshotId}` ||
        state?.sourceSnapshotId !== d.databaseSnapshotId
      ) {
        throw new ReopenStepFormError('Choose whether to restore the offered database checkpoint');
      }
    }
    if (!d.repoSubpath) throw new Error('No DDEV workspace is available for the selected database');
    const handle = await ensureDdevWithProgress(ctx, d.repoSubpath);
    let imported = false;
    const dumpRunnerPath = d.dumpRunnerPath;
    const upload = d.dbUploadId
      ? await ctx.db.query.dbUploads.findFirst({ where: eq(schema.dbUploads.id, d.dbUploadId) })
      : null;
    const pendingUpload = upload?.status === 'complete';
    const savedState = d.databaseSnapshotId
      ? await ctx.db.query.taskDatabaseStates.findFirst({
          where: eq(schema.taskDatabaseStates.taskId, ctx.taskId),
        })
      : null;
    if ((dumpRunnerPath && pendingUpload) || (d.databaseSnapshotId && !savedState?.importedAt)) {
      let snapshotForImport: typeof schema.databaseSnapshots.$inferSelect | null = null;
      if (d.databaseSnapshotId) {
        const snapshot = await ctx.db.query.databaseSnapshots.findFirst({
          where: eq(schema.databaseSnapshots.id, d.databaseSnapshotId),
        });
        if (
          !snapshot ||
          snapshot.status !== 'ready' ||
          savedState?.sourceSnapshotId !== snapshot.id
        )
          throw new Error('The selected saved database is unavailable');
        await ctx.emitProgress('Verifying the saved database…');
        await verifyDatabaseSnapshotFile(snapshot, ctx.signal);
        snapshotForImport = snapshot;
      }
      // A pg_dump archive can't go through `ddev import-db` alone; it is restored
      // with pg_restore inside the db container first. Classified by magic bytes,
      // not by the filename, which carries no reliable extension (`.backup`,
      // `.dump`, `.pgsql`, …).
      // The dump sits in `_uploads/<userId>/`, which is NOT an anchor: that directory is in the
      // `haive_repos` volume the runner mounts from (its own dump file, read-only, since
      // `resolveDumpMounts`). The storage root anchors it and both segments below are walked; a row
      // whose path is not that shape answers null and the sniff is skipped, exactly as an
      // unreadable dump already was.
      const dump = d.dumpWorkerPath ? splitUploadPath(REPO_STORAGE_ROOT, d.dumpWorkerPath) : null;
      const format: DumpImportFormat = dump
        ? await sniffDumpFormat(dump.anchor, dump.rel)
        : { pgRestore: false, gzipped: false };
      // Read once: the engine decides both whether a pg archive can be restored at
      // all and which client the post-import table count speaks.
      const cfgText = d.workspace
        ? await (async () => {
            const { anchor, rel } = ddevConfigRef(d.workspace!);
            return readTextNoFollow(anchor, rel);
          })()
        : null;
      let dbType = cfgText === null ? null : parseDdevConfig(cfgText).dbType;
      if (d.snapshotEngine) {
        const effective = await ddevExec(handle, 'utility configyaml --full-yaml', {
          timeoutMs: 30_000,
        });
        if (effective.exitCode !== 0 || ddevConfigOmitsDatabase(effective.output) !== false)
          throw new Error('The saved database requires a configured DDEV database container');
        dbType = parseDdevConfig(
          effective.output.slice(
            effective.output.indexOf('# Complete processed project configuration:'),
          ),
        ).dbType;
        if (d.snapshotEngine !== (dbType ?? 'mariadb'))
          throw new Error(
            `The saved database uses ${d.snapshotEngine}, but this DDEV project uses ${dbType ?? 'mariadb'}. Select a compatible database or start without a saved database.`,
          );
      }
      if (format.pgRestore) {
        // pg_restore only exists in a postgres db container. An absent `database:`
        // block means DDEV's mariadb default, so a null dbType is still "not
        // postgres"; only an unreadable config leaves the engine unknown, and then
        // the restore itself reports the mismatch.
        if (cfgText !== null && dbType !== 'postgres') {
          throw new Error(
            'The uploaded dump is a PostgreSQL archive (pg_dump -Fc/-Ft), but this ' +
              "project's DDEV database is not postgres. Upload a plain .sql dump, or switch the " +
              'project to a postgres database.',
          );
        }
        await ctx.emitProgress(
          format.gzipped
            ? 'Dump is a gzipped PostgreSQL archive — inflating it and restoring it with pg_restore'
            : 'Dump is a PostgreSQL archive — restoring it with pg_restore',
        );
      }
      const imp = await withDdevProgress(ctx, 'Importing database dump…', (onLine) =>
        d.databaseSnapshotId
          ? importDdevDatabaseSnapshot(handle, snapshotForImport!, ctx.signal, onLine)
          : ddevImportDb(handle, dumpRunnerPath!, { format, timeoutMs: 1_800_000, onLine }),
      );
      if (imp.exitCode !== 0) {
        throw new Error(`ddev import-db failed: ${imp.output.slice(-1500)}`);
      }
      // Exit 0 is not proof a database arrived — see ddevCountTables. Only a
      // CONFIDENT zero blocks; null means the probe could not be read, which is not
      // evidence the database is empty and must not fail a project that is fine.
      const tables = await ddevCountTables(handle, dbType);
      if (tables === 0) {
        throw new Error(
          'The database dump imported without error but the database is EMPTY (0 tables). ' +
            'The dump is most likely for a different engine than this project, or truncated. ' +
            `This project's DDEV database is ${dbType ?? 'mysql/mariadb (DDEV default)'} — ` +
            'upload a dump taken from that engine and retry. Import output: ' +
            imp.output.slice(-800),
        );
      }
      if (tables === null) {
        ctx.logger.warn(
          { taskId: ctx.taskId, dbType },
          'post-import table count could not be read — import left unverified',
        );
      }
      imported = true;
      // Durability snapshot of the freshly-imported DB. It lives on the repo
      // volume (.ddev/.snapshots), so it survives the worker-boot reaper /
      // daemon / host restart that destroys the runner's nested DB —
      // ensureDdevStarted restores it on a cold boot. Non-fatal: the import
      // already succeeded, and a prior attempt's snapshot may already exist.
      const snap = await withDdevProgress(ctx, 'Snapshotting the imported database…', (onLine) =>
        ddevSnapshot(handle, ddevImportSnapshotName(ctx.taskId), { onLine }),
      );
      if (snap.exitCode !== 0) {
        ctx.logger.warn(
          { taskId: ctx.taskId, output: snap.output.slice(-500) },
          'ddev import snapshot non-zero (continuing)',
        );
      }
      // Delete the dump immediately + mark the upload consumed (the env now holds it).
      if (d.dbUploadId) {
        if (dump) await removeNoFollow(dump.anchor, dump.rel).catch(() => {});
        await ctx.db
          .update(schema.dbUploads)
          .set({ status: 'consumed', updatedAt: new Date() })
          .where(eq(schema.dbUploads.id, d.dbUploadId));
      } else {
        ctx.throwIfCancelled();
        if (importEpoch === undefined) throw new Error('The task is unavailable');
        await withSnapshotStep(ctx, importEpoch, async (tx) => {
          await tx
            .update(schema.taskDatabaseStates)
            .set({
              importedAt: new Date(),
              ...(d.snapshotRevision !== undefined ? { baseRevision: d.snapshotRevision } : {}),
            })
            .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId));
        });
      }
    }

    return { imported };
  },
};
