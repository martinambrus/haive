import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { CONFIG_KEYS, configService } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { pathExists } from '../onboarding/_helpers.js';
import { resolveDdevWorkspace } from './_task-meta.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';

// 01d-browser-access — how the user views/tests this task's web app in a browser.
// Asked ONCE, before any runtime starts (after 01-worktree-setup / 01-debug-mode /
// 01b-install-plugins, before 01a-app-boot and 01c-ddev-env), so the per-task runner
// boots in the right mode the FIRST time — DDEV's router ports + host publishing are
// fixed at cold boot and never reconfigured, so the choice must exist beforehand. The
// single boolean is written to tasks.direct_access and read at every runner start by
// resolveTaskDirectAccess:
//   - vnc (default): nothing is published; DDEV keeps its portless 80/443 router and
//     the headed (VNC) browser drives the app in-app. Robust for apps that hard-code
//     their own hostname/port (a portless URL has no port to mismatch).
//   - external: the runner publishes loopback host ports (DDEV also pins its router to
//     them) and the task surfaces the URLs to open in the user's OWN browser.
// A pure detect+form+apply step (no LLM, no CLI). Gated: skipped — direct_access stays
// its default (vnc) — unless the global BROWSER_DIRECT_ACCESS kill-switch is on AND the
// task actually has a browsable runtime.

interface BrowserAccessDetect {
  /** The task's current direct_access, the radio default so an API-set value or a
   *  re-visit survives into the form. */
  currentDirectAccess: boolean;
}

interface BrowserAccessApply {
  directAccess: boolean;
}

/** True when this task will bring up a browsable web runtime: a DDEV project (existing
 *  .ddev/config.yaml or declared containerTool=ddev — mirrors 01c-ddev-env.shouldRun),
 *  or a non-DDEV web app that runs in the per-task app-runner (ready env image +
 *  browserTesting — mirrors 01a-app-boot.shouldRun's containerized branch). Non-web
 *  tasks (libraries, CLIs, backends) have nothing to open in a browser, so the step
 *  skips for them and the runner stays VNC/portless. */
async function hasBrowsableRuntime(ctx: StepContext): Promise<boolean> {
  const tpl = await getTaskEnvTemplate(ctx.db, ctx.taskId);
  const deps = (tpl?.declaredDeps as Record<string, unknown> | null) ?? null;
  const containerTool = (deps?.containerTool as string | undefined) ?? 'none';
  if (containerTool === 'ddev') return true;
  const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
  if (ws && (await pathExists(path.join(ws.workspace, '.ddev', 'config.yaml')))) return true;
  // App-runner web arm: a runnable web app in this task's per-task app-runner.
  if (
    containerTool === 'none' &&
    tpl?.status === 'ready' &&
    !!tpl.imageTag &&
    !!deps?.browserTesting
  ) {
    return true;
  }
  return false;
}

export const browserAccessStep: StepDefinition<BrowserAccessDetect, BrowserAccessApply> = {
  metadata: {
    id: '01d-browser-access',
    workflowType: 'workflow',
    index: 1.3,
    title: 'Browser access',
    description:
      'Choose how to view and test this app in a browser: the in-app (VNC) browser, or your own browser via URLs the task publishes. Asked before the environment starts so it comes up the right way.',
    requiresCli: false,
  },

  // Skip unless direct access is globally enabled AND this task has a browsable runtime.
  // When skipped, direct_access stays its default (false => in-app VNC).
  async shouldRun(ctx: StepContext): Promise<boolean> {
    if (!(await configService.getBoolean(CONFIG_KEYS.BROWSER_DIRECT_ACCESS, true))) return false;
    return hasBrowsableRuntime(ctx);
  },

  async detect(ctx: StepContext): Promise<BrowserAccessDetect> {
    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { directAccess: true },
    });
    return { currentDirectAccess: task?.directAccess ?? false };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Browser access',
      description:
        'How do you want to open this app in a browser to test it? "In-app browser (VNC)" shows the running app inside the task and exposes nothing to your machine, keeping the app on its default URL — most robust for older apps that hard-code their own address. "My own browser" publishes the app on a local URL (shown in the task) so you can use your own browser and devtools; it uses port-specific URLs, which a few apps that hard-code their address handle poorly.',
      fields: [
        {
          type: 'radio',
          id: 'accessMode',
          label: 'Browser access',
          options: [
            { value: 'vnc', label: 'In-app browser (VNC) — Haive displays it (default)' },
            { value: 'external', label: 'My own browser — Haive gives you the URL(s)' },
          ],
          default: detected.currentDirectAccess ? 'external' : 'vnc',
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply(ctx, args): Promise<BrowserAccessApply> {
    const values = args.formValues as Record<string, unknown>;
    const directAccess = values.accessMode === 'external';
    await ctx.db
      .update(schema.tasks)
      .set({ directAccess, updatedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx.logger.info({ directAccess }, 'browser access mode recorded for the task runtime');
    return { directAccess };
  },
};
