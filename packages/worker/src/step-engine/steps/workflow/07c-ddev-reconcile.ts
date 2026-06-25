import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput, pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { matchYamlField, parseDdevConfig, type DdevConfigFields } from '../_ddev-config.js';
import type { DdevBaseline, DdevEnvApply } from './01c-ddev-env.js';
import {
  runnerExec,
  ddevRestart,
  ddevSnapshot,
  ddevMigrateDatabase,
  ddevRegisteredProjectName,
  ddevSafeRename,
} from '../../../sandbox/ddev-runner.js';
import { ensureDdevWithProgress, withDdevProgress } from './_app-runtime.js';

// Reconciles the per-task DDEV runtime with the post-implementation
// `.ddev/config.yaml`. 01c-ddev-env booted DDEV ONCE early on the pre-change
// config; if the implementation upgraded php_version or the database
// type/version, the still-running env is stale and `ensureDdevStarted` (idempotent)
// would never re-apply it — so the verify (08) and browser (08a) steps would
// exercise the wrong runtime. This step, between validation (07b) and verify (08),
// brings the runner in line:
//   - php / webserver / docroot change  -> `ddev restart` (data preserved).
//   - MySQL/MariaDB version or type change -> snapshot + `ddev utility
//     migrate-database <type>:<version>` (the original dump was consumed at 01c,
//     so the snapshot is the only rollback), then restart.
// Gated on 01c having booted + recorded a baseline, so add-ddev tasks (01c skipped,
// 08/08a fresh-boot the new config) and legacy tasks (no baseline) are left alone.

type DriftKind = 'none' | 'restart' | 'db-migrate' | 'unsupported';

interface ReconcileDetect {
  repoSubpath: string | null;
  workspace: string | null;
  baseline: DdevBaseline | null;
  target: DdevConfigFields | null;
  driftKind: DriftKind;
  /** `<type>:<version>` for the migrate path, else null. */
  migrateTarget: string | null;
  unsupportedReason: string | null;
}

interface ReconcileApply {
  action: 'none' | 'restart' | 'migrate';
  reconciled: boolean;
  snapshotName: string | null;
  from: string | null;
  to: string | null;
  output: string;
}

function ddevConfigPath(workspace: string): string {
  return path.join(workspace, '.ddev', 'config.yaml');
}

/** Classify config drift between the booted baseline and the on-disk target.
 *  DB type/version change wins (it needs a migration, not a restart). `ddev
 *  migrate-database` is MySQL/MariaDB only; a null baseline db type means the
 *  project used DDEV's default (mariadb family), still migratable. A non-db
 *  config edit (php/webserver/docroot/…) shows up as a content-hash difference. */
export function classifyDrift(
  baseline: DdevBaseline,
  target: DdevConfigFields,
  targetHash: string,
): { kind: DriftKind; migrateTarget: string | null; unsupportedReason: string | null } {
  const targetDb =
    target.dbType && target.dbVersion ? `${target.dbType}:${target.dbVersion}` : null;
  const baseDb =
    baseline.dbType && baseline.dbVersion ? `${baseline.dbType}:${baseline.dbVersion}` : null;

  if (targetDb && targetDb !== baseDb) {
    if (target.dbType === 'postgres' || baseline.dbType === 'postgres') {
      return {
        kind: 'unsupported',
        migrateTarget: null,
        unsupportedReason:
          `Automatic database change ${baseDb ?? '(default)'} -> ${targetDb} is not supported ` +
          `(ddev migrate-database handles MySQL/MariaDB only, not PostgreSQL). ` +
          `Reconfigure the database manually, or revert the .ddev/config.yaml database block.`,
      };
    }
    return { kind: 'db-migrate', migrateTarget: targetDb, unsupportedReason: null };
  }

  if (targetHash !== baseline.configHash) {
    return { kind: 'restart', migrateTarget: null, unsupportedReason: null };
  }
  return { kind: 'none', migrateTarget: null, unsupportedReason: null };
}

/** Shared loader for detect (form rendering) and apply (authoritative — detect
 *  output is cached and not re-run on retry, so apply re-reads from scratch). */
async function loadReconcileState(ctx: StepContext): Promise<{
  repoSubpath: string | null;
  workspace: string | null;
  baseline: DdevBaseline | null;
  target: DdevConfigFields | null;
  drift: { kind: DriftKind; migrateTarget: string | null; unsupportedReason: string | null };
}> {
  const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
  const row = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01c-ddev-env');
  const baseline = ((row?.output ?? null) as DdevEnvApply | null)?.baseline ?? null;
  const workspace = ws?.workspace ?? null;

  let target: DdevConfigFields | null = null;
  let targetHash: string | null = null;
  if (workspace) {
    const text = await readFile(ddevConfigPath(workspace), 'utf8').catch(() => null);
    if (text !== null) {
      target = parseDdevConfig(text);
      targetHash = createHash('sha256').update(text).digest('hex');
    }
  }

  const drift =
    baseline && target && targetHash !== null
      ? classifyDrift(baseline, target, targetHash)
      : { kind: 'none' as DriftKind, migrateTarget: null, unsupportedReason: null };

  return { repoSubpath: ws?.repoSubpath ?? null, workspace, baseline, target, drift };
}

export const ddevReconcileStep: StepDefinition<ReconcileDetect, ReconcileApply> = {
  metadata: {
    id: '07c-ddev-reconcile',
    workflowType: 'workflow',
    index: 7.8,
    title: 'DDEV reconcile',
    description:
      'Applies post-implementation .ddev/config.yaml changes (php restart; MySQL/MariaDB version migration) to the running DDEV env before verify and browser testing.',
    requiresCli: false,
    allowSkip: true,
  },

  // A reconcile failure (e.g. the implementation wrote an invalid .ddev/config.yaml
  // like `webserver_type: apache`) is a fixable defect: route the thrown error back to
  // the implementation step as a fix-loop diagnosis instead of failing the task.
  fixLoopOnError: true,

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const row = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01c-ddev-env');
    const apply01c = (row?.output ?? null) as DdevEnvApply | null;
    // Only when 01c actually booted DDEV and recorded a baseline (excludes
    // add-ddev where 01c skipped, and legacy tasks with no baseline).
    if (!apply01c?.started || !apply01c.baseline) return false;
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    return ws ? pathExists(ddevConfigPath(ws.workspace)) : false;
  },

  async detect(ctx: StepContext): Promise<ReconcileDetect> {
    const s = await loadReconcileState(ctx);
    return {
      repoSubpath: s.repoSubpath,
      workspace: s.workspace,
      baseline: s.baseline,
      target: s.target,
      driftKind: s.drift.kind,
      migrateTarget: s.drift.migrateTarget,
      unsupportedReason: s.drift.unsupportedReason,
    };
  },

  // Confirmation only for the destructive DB migrate (mirrors 06a-db-migrate's
  // checkbox; pauses even in auto-continue mode since it has a field). The php
  // restart + no-op paths have nothing to decide → an autoSubmit info form so they
  // flow through even in manual mode (instead of a bare "Continue" pause). The
  // unsupported case renders no form and apply throws with the reason.
  form(_ctx, detected): FormSchema | null {
    if (detected.driftKind === 'db-migrate') {
      return {
        title: 'DDEV database migration',
        description: [
          `The implementation changed the database to ${detected.migrateTarget}.`,
          `This runs "ddev utility migrate-database ${detected.migrateTarget}" on the imported database`,
          'after taking a snapshot (restore with "ddev snapshot restore haive-pre-migrate-<task>").',
          'Uncheck to leave the database unchanged — DDEV stays as booted and the new database config is not applied.',
        ].join('\n'),
        fields: [
          {
            type: 'checkbox',
            id: 'confirmDbMigration',
            label: `Migrate database to ${detected.migrateTarget}`,
            default: true,
          },
        ],
        submitLabel: 'Reconcile DDEV environment',
      };
    }
    // Unsupported DB change → no form; apply throws with the reason.
    if (detected.driftKind === 'unsupported') return null;
    // restart / none: nothing for the user to decide (a non-destructive `ddev
    // restart`, or a no-op). Auto-submit so it flows through even in manual mode.
    return {
      title: 'DDEV reconcile',
      description:
        detected.driftKind === 'restart'
          ? 'Applying the post-implementation .ddev/config.yaml change to the running DDEV environment (restart — data preserved).'
          : 'No DDEV config changes since boot — nothing to reconcile.',
      fields: [],
      submitLabel: 'Continue',
      autoSubmit: true,
    };
  },

  async apply(ctx, args): Promise<ReconcileApply> {
    // Re-derive from scratch — detect output is cached across retries.
    const { repoSubpath, workspace, baseline, target, drift } = await loadReconcileState(ctx);

    const noop = (output: string): ReconcileApply => ({
      action: 'none',
      reconciled: false,
      snapshotName: null,
      from: null,
      to: null,
      output,
    });

    if (!repoSubpath || !baseline || !target) {
      return noop('no DDEV baseline/workspace — nothing to reconcile');
    }
    if (drift.kind === 'none') {
      return noop('DDEV config unchanged since boot');
    }
    if (drift.kind === 'unsupported') {
      throw new Error(drift.unsupportedReason ?? 'unsupported DDEV database change');
    }

    // The runner can be reaped between 01c's boot and now (worker restart, host
    // reboot, days elapsed) — a bare `ddevRestart`/`runnerExec` would then fail with
    // "No such container". ensureDdevStarted returns the live handle when the env is
    // still up (preserving the imported DB), else re-boots the runner + `ddev start`
    // on the current .ddev/config.yaml. For the restart path that fresh start already
    // applies the new config, so the `ddevRestart` below becomes an idempotent re-apply.
    const handle = await ensureDdevWithProgress(ctx, repoSubpath);

    // --- DB migration path (MySQL/MariaDB version or type change) ---
    if (drift.kind === 'db-migrate' && drift.migrateTarget) {
      const confirmed = (args.formValues as { confirmDbMigration?: boolean }).confirmDbMigration;
      const fromDb = `${baseline.dbType}:${baseline.dbVersion}`;

      if (confirmed === false) {
        // Declining a db engine/version change leaves config (new) and data (old)
        // mismatched — a `ddev restart` would then fail to boot. So leave DDEV
        // exactly as 01c booted it (don't restart) and surface that the change was
        // not applied; the user can skip the step or revert the .ddev db block.
        ctx.logger.info('DB migration declined by user — leaving DDEV unchanged');
        return {
          action: 'none',
          reconciled: false,
          snapshotName: null,
          from: fromDb,
          to: drift.migrateTarget,
          output:
            'DB migration declined; DDEV left at its booted state — verify/browser testing will ' +
            'run against the pre-change database (the .ddev database change was not applied).',
        };
      }

      const snapshotName = `haive-pre-migrate-${ctx.taskId}`;
      const marker = `/tmp/haive-db-migrated-${ctx.taskId}`;
      // Idempotency: the runner is kept alive on a failed step, so a Retry re-runs
      // apply. The marker (written only after a successful migrate) means "already
      // migrated" — skip straight to the restart rather than double-migrating.
      const seen = await runnerExec(handle, `test -f ${marker} && echo HAIVE_MIGRATED || true`, {
        timeoutMs: 15_000,
      });
      if (!seen.output.includes('HAIVE_MIGRATED')) {
        ctx.throwIfCancelled();
        const snap = await withDdevProgress(
          ctx,
          'Snapshotting the database before migration…',
          (onLine) => ddevSnapshot(handle, snapshotName, { onLine }),
        );
        if (snap.exitCode !== 0) {
          // A snapshot from a prior failed attempt may already exist — tolerate
          // and proceed (the earlier snapshot is still a valid pre-migrate backup).
          ctx.logger.warn(
            { snapshotName, output: snap.output.slice(-500) },
            'ddev snapshot non-zero (continuing to migrate)',
          );
        }
        ctx.throwIfCancelled();
        const mig = await withDdevProgress(
          ctx,
          `Migrating database to ${drift.migrateTarget}…`,
          (onLine) => ddevMigrateDatabase(handle, drift.migrateTarget!, { onLine }),
        );
        if (mig.exitCode !== 0) {
          throw new Error(
            `ddev migrate-database ${drift.migrateTarget} failed (DB backed up as snapshot ` +
              `"${snapshotName}"; restore with: ddev snapshot restore ${snapshotName}): ` +
              mig.output.slice(-1500),
          );
        }
        await runnerExec(handle, `touch ${marker}`, { timeoutMs: 15_000 });
      } else {
        ctx.logger.info({ marker }, 'DB already migrated (marker present) — skipping re-migrate');
      }

      ctx.throwIfCancelled();
      const r = await withDdevProgress(
        ctx,
        'Restarting DDEV to apply the migrated database + config…',
        (onLine) => ddevRestart(handle, { onLine }),
        { initialLine: 'stopping containers…' },
      );
      if (r.exitCode !== 0)
        throw new Error(`ddev restart after migrate failed: ${r.output.slice(-1500)}`);
      return {
        action: 'migrate',
        reconciled: true,
        snapshotName,
        from: fromDb,
        to: drift.migrateTarget,
        output: `Migrated database ${fromDb} -> ${drift.migrateTarget} and restarted DDEV.`,
      };
    }

    // --- Restart path (php / webserver / docroot / other config change) ---
    ctx.throwIfCancelled();
    // A project NAME change can't be applied by `ddev restart`: the approot is registered
    // under the OLD name, so DDEV refuses ("already contains a project named <old>"). Detect
    // it and do a data-safe rename (snapshot -> stop --unlist old -> start new -> restore)
    // instead of restarting into the conflict.
    const registeredName = await ddevRegisteredProjectName(handle);
    const configText = workspace
      ? await readFile(ddevConfigPath(workspace), 'utf8').catch(() => null)
      : null;
    const configName = configText ? matchYamlField(configText, 'name') : null;
    if (registeredName && configName && registeredName !== configName) {
      const snapshotName = `haive-pre-rename-${ctx.taskId}`;
      const renamed = await withDdevProgress(
        ctx,
        `Renaming DDEV project ${registeredName} → ${configName}…`,
        (onLine) => ddevSafeRename(handle, registeredName, snapshotName, { onLine }),
        { initialLine: 'snapshotting + restarting…' },
      );
      if (renamed.exitCode !== 0) {
        throw new Error(
          `ddev rename ${registeredName} → ${configName} failed: ${renamed.output.slice(-1500)}`,
        );
      }
      return {
        action: 'restart',
        reconciled: true,
        snapshotName,
        from: registeredName,
        to: configName,
        output: `Renamed DDEV project ${registeredName} → ${configName} (snapshot + restart, data preserved).`,
      };
    }
    const r = await withDdevProgress(
      ctx,
      'Restarting DDEV to apply the new configuration…',
      (onLine) => ddevRestart(handle, { onLine }),
      { initialLine: 'stopping containers…' },
    );
    if (r.exitCode !== 0) throw new Error(`ddev restart failed: ${r.output.slice(-1500)}`);
    return {
      action: 'restart',
      reconciled: true,
      snapshotName: null,
      from: baseline.phpVersion,
      to: target.phpVersion,
      output: `Restarted DDEV to apply config (php ${baseline.phpVersion ?? '?'} -> ${target.phpVersion ?? '?'}).`,
    };
  },
};
