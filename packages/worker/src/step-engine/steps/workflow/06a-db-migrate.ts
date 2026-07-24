import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import {
  runnerHandleForTask,
  ddevExec,
  ddevSnapshot,
  ddevMigratedSnapshotName,
} from '../../../sandbox/ddev-runner.js';
import { withDdevProgress } from './_app-runtime.js';

// Runs the framework's DB migrations inside the task's DDEV environment, after
// gate-1 (spec approved) and before implementation. Critical when an old DB was
// imported under new code: the schema must be brought up to the code's
// expectations before agents read/write it. Deterministic (no LLM); blocks the
// pipeline on failure. Gated on the DDEV env (`.ddev/config.yaml`) — projects
// without DDEV skip it. allowSkip is set so the user may Skip this one step.

type Framework =
  'drupal' | 'laravel' | 'symfony' | 'django' | 'rails' | 'wordpress' | 'prisma' | 'unknown';

interface MigrateDetect {
  framework: Framework;
  /** Command to run via `ddev exec` (empty when unknown). */
  migrationCommand: string;
  repoSubpath: string | null;
}

interface MigrateApply {
  ran: boolean;
  skipped: boolean;
  passed: boolean;
  command: string | null;
  output: string;
}

function ddevConfigPath(workspace: string): string {
  return path.join(workspace, '.ddev', 'config.yaml');
}

async function detectFramework(workspace: string): Promise<Framework> {
  const composer = path.join(workspace, 'composer.json');
  if (await pathExists(composer)) {
    try {
      const raw = await readFile(composer, 'utf8');
      if (/drupal\/core/.test(raw)) return 'drupal';
      if (/laravel\/framework/.test(raw)) return 'laravel';
      if (/symfony\//.test(raw)) return 'symfony';
    } catch {
      /* fall through */
    }
  }
  if (await pathExists(path.join(workspace, 'manage.py'))) return 'django';
  if (await pathExists(path.join(workspace, 'bin', 'rails'))) return 'rails';
  if (await pathExists(path.join(workspace, 'wp-config.php'))) return 'wordpress';
  if (await pathExists(path.join(workspace, 'prisma', 'schema.prisma'))) return 'prisma';
  return 'unknown';
}

function commandFor(framework: Framework): string {
  switch (framework) {
    case 'drupal':
      return 'drush updatedb -y';
    case 'laravel':
      return 'php artisan migrate --force';
    case 'symfony':
      return 'php bin/console doctrine:migrations:migrate --no-interaction';
    case 'django':
      return 'python manage.py migrate --noinput';
    case 'rails':
      return 'bin/rails db:migrate';
    case 'wordpress':
      return 'wp core update-db';
    case 'prisma':
      return 'npx prisma migrate deploy';
    case 'unknown':
      return '';
  }
}

export const dbMigrateStep: StepDefinition<MigrateDetect, MigrateApply> = {
  needsRuntime: 'ddev',
  metadata: {
    id: '06a-db-migrate',
    workflowType: 'workflow',
    index: 6.1,
    title: 'Database migrations',
    description:
      'Runs the framework DB migrations inside the DDEV environment before implementation.',
    requiresCli: false,
    allowSkip: true,
    // Under auto-continue, run the detected migration on its defaults (runMigration
    // ticked + detected command, or skip when no framework/command) instead of
    // parking; manual mode still gates. Failure blocks with retry/skip recovery.
    autoSubmitDefaults: true,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    return ws ? pathExists(ddevConfigPath(ws.workspace)) : false;
  },

  async detect(ctx: StepContext): Promise<MigrateDetect> {
    // Detect the framework + target the runner against the worktree (migration
    // files + the 01c-booted runner both live there), not the repo root.
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const framework = ws ? await detectFramework(ws.workspace) : 'unknown';
    return {
      framework,
      migrationCommand: commandFor(framework),
      repoSubpath: ws?.repoSubpath ?? null,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Database migrations',
      description: [
        `Framework: ${detected.framework}`,
        detected.migrationCommand
          ? `Detected command: ${detected.migrationCommand}`
          : 'No migration command detected for this framework — edit below or uncheck to skip.',
        'Runs inside the DDEV environment (ddev exec), required before implementation when an old DB was imported under new code.',
      ].join('\n'),
      fields: [
        {
          type: 'checkbox',
          id: 'runMigration',
          label: 'Run database migrations',
          default: detected.migrationCommand !== '',
        },
        {
          type: 'text',
          id: 'migrationCommand',
          label: 'Migration command (run via ddev exec)',
          default: detected.migrationCommand,
        },
      ],
      submitLabel: 'Run migrations',
    };
  },

  async apply(ctx, args): Promise<MigrateApply> {
    const d = args.detected;
    const values = args.formValues as { runMigration?: boolean; migrationCommand?: string };
    const command = (values.migrationCommand ?? d.migrationCommand).trim();

    if (values.runMigration === false || !command) {
      return {
        ran: false,
        skipped: true,
        passed: true,
        command: command || null,
        output: 'migrations skipped',
      };
    }
    if (!d.repoSubpath) {
      throw new Error('06a-db-migrate: task has no repository');
    }

    const handle = runnerHandleForTask(ctx.taskId, d.repoSubpath);

    // Pre-flight (Drupal): `drush updatedb` requires a bootstrappable, installed
    // site with a wired DB connection. On a site that was never installed — no
    // sites/default/settings.php, DDEV project `type: php` (so no auto-generated
    // settings.ddev.php), empty database — drush cannot bootstrap and updatedb
    // dies with an OPAQUE "Bootstrap failed. Run your command with -vvv"
    // (the real "database connection is not defined: default" is only under -vvv).
    // That hard-blocks the whole pipeline with no actionable reason, yet there is
    // nothing to migrate on such a site. So probe the DB connection first and skip
    // gracefully (with a clear note) instead of failing. `drush status
    // --field=db-status` reports "Connected" ONLY when the connection is live
    // (empty when the site can't bootstrap) — a stable, documented drush field
    // that exits 0 either way, so we key on the value, not the exit code.
    if (d.framework === 'drupal') {
      const probe = await ddevExec(handle, 'exec drush status --field=db-status', {
        timeoutMs: 60_000,
      });
      if (!/connected/i.test(probe.output)) {
        ctx.logger.warn(
          { taskId: ctx.taskId, probe: probe.output.slice(-300) },
          '06a-db-migrate: Drupal has no live DB connection — skipping migration (site not installed / DB not wired)',
        );
        return {
          ran: false,
          skipped: true,
          passed: true,
          command,
          output:
            'Drupal has no live database connection (site not installed, or settings.php + DDEV DB not wired) — ' +
            'drush updatedb would fail to bootstrap, so the migration was skipped. If this site should have a ' +
            'migratable database, set the DDEV project type to "drupal" and import the database, then retry.',
        };
      }
    }

    const res = await withDdevProgress(ctx, `Running migrations: ${command}`, (onLine) =>
      ddevExec(handle, `exec ${command}`, { timeoutMs: 1_800_000, onLine }),
    );
    if (res.exitCode !== 0) {
      // Block the pipeline — the recovery options (retry / retry-with-AI / skip)
      // are surfaced on the failed step.
      throw new Error(`migration failed (${command}): ${res.output.slice(-1500)}`);
    }

    // Durability snapshot of the migrated DB so a cold boot (worker/host restart)
    // restores the MIGRATED state, not the pre-migration import. Lives on the repo
    // volume; ensureDdevStarted prefers it over the import snapshot. Non-fatal.
    const snap = await withDdevProgress(ctx, 'Snapshotting the migrated database…', (onLine) =>
      ddevSnapshot(handle, ddevMigratedSnapshotName(ctx.taskId), { onLine }),
    );
    if (snap.exitCode !== 0) {
      ctx.logger.warn(
        { taskId: ctx.taskId, output: snap.output.slice(-500) },
        'ddev post-migrate snapshot non-zero (continuing)',
      );
    }

    ctx.logger.info({ taskId: ctx.taskId, command }, 'db migrations applied');
    return {
      ran: true,
      skipped: false,
      passed: true,
      command,
      output: res.output.slice(-2000),
    };
  },
};
