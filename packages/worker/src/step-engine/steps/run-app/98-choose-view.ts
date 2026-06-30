import path from 'node:path';
import { eq } from 'drizzle-orm';
import { CONFIG_KEYS, configService } from '@haive/shared';
import type { FormSchema } from '@haive/shared';
import { schema } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { resolveDdevWorkspace } from '../workflow/_task-meta.js';
import { pathExists } from '../onboarding/_helpers.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';

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

/** run_app viewing-mode gate. Runs BEFORE the runtime bring-up (01c-ddev-env /
 *  01a-app-boot) — like 01d-browser-access for workflow tasks — so the runner is
 *  CREATED with the chosen surface: 'direct' publishes loopback host ports (read at
 *  runner create via resolveTaskDirectAccess from tasks.direct_access; host publishing
 *  is fixed at cold boot and never reconfigured), 'vnc'/default stays portless. The
 *  runtime hold step (99-run-app-ready) then surfaces only the chosen view: VNC
 *  navigates the in-runner headed browser to the app, own-browser shows the URL and
 *  never starts the VNC desktop. Mirrors 08a-browser-setup's interactive-vs-direct
 *  choice. */
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
    // DDEV-only feature. This step now runs BEFORE the runtime bring-up (01c-ddev-env),
    // so a generated .ddev/config.yaml does not exist yet — detect DDEV from the declared
    // container tool (mirrors 01c-ddev-env.shouldRun / 01d hasBrowsableRuntime), falling
    // back to an already-present repo-supplied config.
    const tpl = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const containerTool = (tpl?.declaredDeps as { containerTool?: string } | null | undefined)
      ?.containerTool;
    const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
    const ddevMode =
      containerTool === 'ddev' ||
      (ws !== null && (await pathExists(path.join(ws.workspace, '.ddev', 'config.yaml'))));
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
    // Persist the access surface onto the task: the runtime bring-up that runs AFTER this
    // step (01c-ddev-env / 01a-app-boot, via resolveTaskDirectAccess) reads tasks.direct_access
    // at runner CREATE to decide host-port publishing, so run_app honors the chosen surface
    // like workflow's 01d-browser-access.
    const directAccess = viewMode === 'direct';
    await ctx.db
      .update(schema.tasks)
      .set({ exposeDbPort, directAccess, updatedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info({ viewMode, exposeDbPort, directAccess }, 'run-app viewing mode chosen');
    return { viewMode };
  },
};
