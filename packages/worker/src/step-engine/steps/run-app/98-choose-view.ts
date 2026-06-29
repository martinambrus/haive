import path from 'node:path';
import { eq } from 'drizzle-orm';
import { CONFIG_KEYS, configService } from '@haive/shared';
import type { FormSchema } from '@haive/shared';
import { schema } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { resolveDdevWorkspace } from '../workflow/_task-meta.js';
import { pathExists } from '../onboarding/_helpers.js';

interface ChooseViewDetect {
  /** Own-browser access is offered only when the global direct-access flag is on. */
  directAccessAvailable: boolean;
  /** Db-port opt-in is offered only when the global db-access flag is on AND this
   *  run_app task has a DDEV runtime (the feature is DDEV-only). */
  dbExposeAvailable: boolean;
  /** Current task-level expose_db_port column — the checkbox default. */
  taskExposeDbPort: boolean;
}

interface ChooseViewApply {
  /** 'vnc' = watch/control the in-app browser; 'direct' = open in the user's own browser. */
  viewMode: 'vnc' | 'direct';
}

/** run_app viewing-mode gate. The user picks ONE surface BEFORE the runtime hold
 *  step (99-run-app-ready) so that step brings up only the chosen surface: VNC
 *  navigates the in-runner headed browser to the app, own-browser does not start
 *  the VNC desktop at all (it only slows the user's own-browser session). Mirrors
 *  08a-browser-setup's interactive-vs-direct choice. */
export const chooseViewStep: StepDefinition<ChooseViewDetect, ChooseViewApply> = {
  metadata: {
    id: '98-choose-view',
    workflowType: 'run_app',
    index: 0,
    title: 'Choose how to view the app',
    description:
      'Pick whether to view the running app in the in-app browser (VNC) or your own browser.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<ChooseViewDetect> {
    const directAccessAvailable = await configService.getBoolean(
      CONFIG_KEYS.BROWSER_DIRECT_ACCESS,
      true,
    );
    const dbAvailable = await configService.getBoolean(CONFIG_KEYS.DB_DIRECT_ACCESS, true);
    // DDEV-only feature: 01c-ddev-env runs before this step, so the worktree's .ddev
    // config (generated or repo-supplied) is present when DDEV is the runtime.
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const ddevMode =
      ws !== null && (await pathExists(path.join(ws.workspace, '.ddev', 'config.yaml')));
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { exposeDbPort: true },
    });
    return {
      directAccessAvailable,
      dbExposeAvailable: dbAvailable && ddevMode,
      taskExposeDbPort: task?.exposeDbPort ?? false,
    };
  },

  form(_ctx: StepContext, detected): FormSchema {
    const options = [
      {
        value: 'vnc',
        label: 'In-app browser (VNC) — watch and control it here; we open it on the app for you',
      },
      ...(detected.directAccessAvailable
        ? [
            {
              value: 'direct',
              label: 'My own browser — open the app via a URL we provide (no in-app VNC)',
            },
          ]
        : []),
    ];
    return {
      title: 'Choose how to view the app',
      description:
        'Pick one. Only the surface you pick is shown on the next screen — the other never starts.',
      fields: [
        {
          type: 'radio' as const,
          id: 'viewMode',
          label: 'Viewing mode',
          options,
          default: 'vnc',
          required: true,
        },
        // Independent of the viewing mode: expose this project's DDEV database on a
        // loopback host port so a local DB client can connect while the app runs.
        ...(detected.dbExposeAvailable
          ? [
              {
                type: 'checkbox' as const,
                id: 'exposeDbPort',
                label: 'Also expose the database port to my machine',
                description:
                  'Publishes this project’s DDEV database on a loopback port (127.0.0.1) so you can connect a local DB client (mysql/psql/DataGrip). Off by default.',
                default: detected.taskExposeDbPort,
              },
            ]
          : []),
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx: StepContext, args): Promise<ChooseViewApply> {
    const v = args.formValues as { viewMode?: string; exposeDbPort?: boolean };
    const viewMode: ChooseViewApply['viewMode'] = v.viewMode === 'direct' ? 'direct' : 'vnc';
    // Persist the db-port opt-in onto the task so the runtime bring-up
    // (maybeExposeDdevDbPort) and the surface (resolveDdevDbAccess) read it. Only
    // meaningful when the field was shown (DDEV + global on); defaults false otherwise.
    const exposeDbPort = v.exposeDbPort === true;
    await ctx.db
      .update(schema.tasks)
      .set({ exposeDbPort, updatedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info({ viewMode, exposeDbPort }, 'run-app viewing mode chosen');
    return { viewMode };
  },
};
