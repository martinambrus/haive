import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { readTextNoFollow, openFileNoFollow } from '@haive/shared/fs-safe';
import { databaseSnapshotRel } from '@haive/shared/database-snapshot-files';
import type { FormSchema } from '@haive/shared';
import {
  ReopenStepFormError,
  TaskCancelledError,
  type StepDefinition,
} from '../../step-definition.js';
import { StepSupersededError } from '../../step-ownership.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import { parseDdevConfig } from '../_ddev-config.js';
import {
  ddevConfigOmitsDatabase,
  ddevCountTables,
  ddevExec,
  ddevRunnerRunning,
  runnerHandleForTask,
} from '../../../sandbox/ddev-runner.js';
import { exportDdevDatabase } from '../../../sandbox/ddev-database-export.js';
import { gitRun } from '../../../repo/git-exec.js';
import {
  DATABASE_SAVE_STEP_ID,
  databaseSnapshotStorageRoot,
  loadDatabaseSnapshotState,
  reserveDatabaseSnapshot,
  promoteDatabaseSnapshot,
  discardDatabaseSnapshot,
  sweepDatabaseSnapshots,
  withSnapshotStep,
} from '../../../repo/database-snapshots.js';

type Detected = Awaited<ReturnType<typeof loadDatabaseSnapshotState>>;

export function databaseSaveForm(d: Detected): FormSchema | null {
  if (!d || d.state.outcome !== 'pending') return null;
  const conflict = d.revision !== d.state.baseRevision;
  const current = d.current;
  return {
    title: conflict ? 'The project database changed during this task' : 'Save project database',
    description: [
      d.state.exportError ? `Database export failed: ${d.state.exportError}` : '',
      conflict
        ? 'Another task changed the saved project database. Overwriting selects this task’s complete database; it does not merge the databases.'
        : 'Choose whether to save this task’s DDEV database locally for the next task.',
      current
        ? `Last saved by task **${current.sourceTaskId ?? '(deleted task)'}**, on ${new Date(current.createdAt).toISOString()}.`
        : '',
      'Finishing without saving deletes any unused snapshot from this task.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    autoSubmit: false,
    fields: [
      ...(current
        ? [
            {
              id: 'sourceTask',
              type: 'note' as const,
              label: 'Task that last saved the project database',
              body: current.sourceTaskTitle,
            },
          ]
        : []),
      {
        id: 'action',
        type: 'select',
        label: 'Database snapshot',
        required: true,
        default: 'discard',
        options: [
          { value: 'discard', label: 'Finish without saving the database' },
          {
            value: `${conflict ? 'replace' : 'save'}:${d.revision}`,
            label: conflict
              ? 'Save and overwrite the current database'
              : 'Save database for the next task',
          },
        ],
      },
    ],
    submitLabel: 'Continue',
  };
}

export const saveDatabaseStep: StepDefinition<Detected, { outcome: string; snapshotId?: string }> =
  {
    metadata: {
      id: DATABASE_SAVE_STEP_ID,
      workflowType: 'workflow',
      index: 13,
      title: 'Save project database',
      description:
        'Save the DDEV primary database locally for the next task, before workspace cleanup.',
      requiresCli: false,
      allowSkip: true,
      alwaysWaitForUser: true,
    },
    async shouldRun(ctx) {
      const task = await ctx.db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
      if (!task?.repositoryId) return false;
      const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
      if (!ws) return false;
      const { anchor, prefix } = workspaceAnchor(ws.workspace);
      return (await readTextNoFollow(anchor, `${prefix}.ddev/config.yaml`)) !== null;
    },
    detect: loadDatabaseSnapshotState,
    form: (_ctx, d) => databaseSaveForm(d),
    async apply(ctx, args) {
      let d = await loadDatabaseSnapshotState(ctx);
      if (!d) return { outcome: 'skipped' };
      if (d.state.outcome !== 'pending') return { outcome: d.state.outcome };
      if (args.formValues.action === 'discard') {
        return { outcome: await discardDatabaseSnapshot(ctx, d.epoch) };
      }
      const action = String(args.formValues.action ?? '');
      const match = /^(save|replace):(\d+)$/.exec(action);
      const approved = match ? Number(match[2]) : NaN;
      const expected = d.revision === d.state.baseRevision ? 'save' : 'replace';
      if (
        !match ||
        !Number.isSafeInteger(approved) ||
        approved !== d.revision ||
        match[1] !== expected
      ) {
        throw new ReopenStepFormError(
          'Choose whether to save the database; review the current project snapshot',
        );
      }
      let candidate = d.candidate?.status === 'ready' ? d.candidate : null;
      if (!candidate) {
        try {
          const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
          if (!ws) throw new Error('No DDEV workspace is available');
          const handle = runnerHandleForTask(ctx.taskId, ws.repoSubpath);
          // Saving must never cold-boot and export an older recovery database as the final state.
          if (!(await ddevRunnerRunning(handle)))
            throw new Error(
              'The task’s DDEV runtime is unavailable. Retry after restoring the runtime, or finish without saving.',
            );
          const config = await ddevExec(handle, 'utility configyaml --full-yaml', {
            timeoutMs: 30_000,
          });
          if (config.exitCode !== 0)
            throw new Error(
              `Cannot read the running DDEV configuration: ${config.output.slice(-1000)}`,
            );
          const omitted = ddevConfigOmitsDatabase(config.output);
          if (omitted === null)
            throw new Error('The running DDEV database configuration could not be verified');
          if (omitted) {
            await discardDatabaseSnapshot(ctx, d.epoch);
            return { outcome: 'no database container' };
          }
          const fields = parseDdevConfig(
            config.output.slice(
              config.output.indexOf('# Complete processed project configuration:'),
            ),
          );
          if ((await ddevCountTables(handle, fields.dbType)) === 0) {
            await discardDatabaseSnapshot(ctx, d.epoch);
            return { outcome: 'empty database; no snapshot saved' };
          }
          const commit = await gitRun(ws.workspace, ['rev-parse', 'HEAD']).catch(() => null);
          candidate = await reserveDatabaseSnapshot(ctx, d.epoch, {
            engine: fields.dbType ?? 'mariadb',
            engineVersion: fields.dbVersion,
            codeCommit: commit?.code === 0 ? commit.stdout.trim() : null,
          });
          await ctx.emitProgress('Exporting the DDEV database for the next task…');
          const root = databaseSnapshotStorageRoot();
          const rel = databaseSnapshotRel(candidate);
          const result = await exportDdevDatabase(handle, root, rel, ctx.signal, () =>
            withSnapshotStep(ctx, d.epoch, async (tx) => {
              const inventory = await tx.query.databaseSnapshots.findFirst({
                where: eq(schema.databaseSnapshots.id, candidate!.id),
              });
              if (inventory?.status !== 'writing') throw new StepSupersededError(ctx.taskStepId);
              // Open while GC is excluded. Once unlocked, GC may unlink this held file,
              // but the exporter cannot create bytes after its inventory was removed.
              return openFileNoFollow(root, `${rel}.partial`, 'create-exclusive', {
                createParents: true,
                fileMode: 0o644,
              });
            }),
          );
          await withSnapshotStep(ctx, d.epoch, async (tx) => {
            await tx
              .update(schema.databaseSnapshots)
              .set({ status: 'ready', ...result })
              .where(eq(schema.databaseSnapshots.id, candidate!.id));
            await tx
              .update(schema.taskDatabaseStates)
              .set({ exportError: null })
              .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId));
          });
        } catch (err) {
          ctx.throwIfCancelled();
          if (err instanceof TaskCancelledError || err instanceof StepSupersededError) throw err;
          await withSnapshotStep(ctx, d.epoch, async (tx) => {
            if (candidate)
              await tx
                .update(schema.databaseSnapshots)
                .set({ status: 'deleting' })
                .where(eq(schema.databaseSnapshots.id, candidate.id));
            await tx
              .update(schema.taskDatabaseStates)
              .set({
                exportError: String(err instanceof Error ? err.message : err),
                candidateSnapshotId: null,
                candidateStepId: null,
                decisionEpoch: d.epoch,
              })
              .where(eq(schema.taskDatabaseStates.taskId, ctx.taskId));
          });
          await sweepDatabaseSnapshots(ctx.db);
          throw new ReopenStepFormError(
            'Database export failed; choose whether to retry saving or finish without saving',
          );
        }
      }
      const outcome = await promoteDatabaseSnapshot(ctx, d.epoch, approved);
      if (outcome === 'conflict') {
        throw new ReopenStepFormError(
          'Another task changed the current database; review the latest snapshot',
        );
      }
      await sweepDatabaseSnapshots(ctx.db);
      return { outcome, ...(outcome === 'saved' ? { snapshotId: candidate.id } : {}) };
    },
  };
