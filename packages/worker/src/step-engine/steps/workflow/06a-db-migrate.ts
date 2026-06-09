import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { runnerHandleForTask, ddevExec } from '../../../sandbox/ddev-runner.js';

// Runs the framework's DB migrations inside the task's DDEV environment, after
// gate-1 (spec approved) and before implementation. Critical when an old DB was
// imported under new code: the schema must be brought up to the code's
// expectations before agents read/write it. Deterministic (no LLM); blocks the
// pipeline on failure. Gated on the DDEV env (`.ddev/config.yaml`) — projects
// without DDEV skip it. allowSkip is set so the user may Skip this one step.

type Framework =
  | 'drupal'
  | 'laravel'
  | 'symfony'
  | 'django'
  | 'rails'
  | 'wordpress'
  | 'prisma'
  | 'unknown';

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
  metadata: {
    id: '06a-db-migrate',
    workflowType: 'workflow',
    index: 6.1,
    title: 'Database migrations',
    description:
      'Runs the framework DB migrations inside the DDEV environment before implementation.',
    requiresCli: false,
    allowSkip: true,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    return pathExists(ddevConfigPath(ctx.workspacePath));
  },

  async detect(ctx: StepContext): Promise<MigrateDetect> {
    const framework = await detectFramework(ctx.workspacePath);
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { userId: true, repositoryId: true },
    });
    return {
      framework,
      migrationCommand: commandFor(framework),
      repoSubpath: task?.repositoryId ? `${task.userId}/${task.repositoryId}` : null,
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
    await ctx.emitProgress(`Running migrations: ${command}`);
    const res = await ddevExec(handle, `exec ${command}`, { timeoutMs: 1_800_000 });
    if (res.exitCode !== 0) {
      // Block the pipeline — the recovery options (retry / retry-with-AI / skip)
      // are surfaced on the failed step.
      throw new Error(`migration failed (${command}): ${res.output.slice(-1500)}`);
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
