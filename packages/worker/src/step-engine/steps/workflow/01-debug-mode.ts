import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { CONFIG_KEYS, configService } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';

// 01-debug-mode — on-demand step-debugging toggle. Asked once, before any runtime
// starts (registered after 01-worktree-setup and before 01a-app-boot / 01c-ddev-env),
// so the choice is known when the DDEV runner / app-runner / IDE come up. A pure
// detect+form+apply step: no LLM, no CLI. The single boolean is written to
// tasks.debug_mode and re-read at every runner start (survives warm-recover); the
// lanes that act on it (PHP/Xdebug, VNC-browser JS, Node --inspect) live in the
// runner + IDE start paths. Gated behind the global DEBUG_MODE_ENABLED kill-switch:
// when off the whole step is skipped and debug_mode stays its default (off).

interface DebugModeDetect {
  /** The task's current debug_mode, used as the checkbox default so an API-set
   *  value (or a re-visit) survives into the form. */
  currentDebugMode: boolean;
}

interface DebugModeApply {
  debugMode: boolean;
}

export const debugModeStep: StepDefinition<DebugModeDetect, DebugModeApply> = {
  metadata: {
    id: '01-debug-mode',
    workflowType: 'workflow',
    index: 1.1,
    title: 'Debug mode',
    description:
      'Choose whether to run this task with step-debugging wired into the live runtime, so you can set breakpoints from the Editor tab. Off by default — turn it on only when you need to debug.',
    requiresCli: false,
  },

  // Skip the whole step when the global debug feature is off; debug_mode then stays
  // its default (off). Default true (feature available) mirrors the other runtime
  // kill-switches (IDE, direct browser access).
  async shouldRun(): Promise<boolean> {
    return configService.getBoolean(CONFIG_KEYS.DEBUG_MODE_ENABLED, true);
  },

  async detect(ctx: StepContext): Promise<DebugModeDetect> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { debugMode: true },
    });
    return { currentDebugMode: task?.debugMode ?? false };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Debug mode',
      description:
        'When enabled, the per-task runtime comes up with step-debugging ready and the Editor tab gets matching launch configurations: PHP via Xdebug (DDEV apps), client-side JavaScript via the in-app (VNC) browser, and Node via --inspect. Debugging adds runtime overhead, so leave it off unless you intend to use it — you can still finish the task normally with it on.',
      fields: [
        {
          type: 'checkbox',
          id: 'enableDebug',
          label: 'Enable step debugging for this task',
          default: detected.currentDebugMode,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<DebugModeApply> {
    const values = args.formValues as Record<string, unknown>;
    const debugMode = typeof values.enableDebug === 'boolean' ? values.enableDebug : false;
    await ctx.db
      .update(schema.tasks)
      .set({ debugMode, updatedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info({ debugMode }, 'debug mode recorded for the task runtime');
    return { debugMode };
  },
};
