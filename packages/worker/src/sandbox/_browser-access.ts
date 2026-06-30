import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { getDb } from '../db.js';

/** Pure AND of the global kill-switch and the per-task opt-in. Extracted so the
 *  precedence (global off ALWAYS wins) and the default (missing/false column =>
 *  portless) are unit-testable without mocking config/db — mirrors decideDdevRecovery
 *  in ddev-runner. */
export function decideDirectAccess(
  globalOn: boolean,
  taskDirectAccess: boolean | null | undefined,
): boolean {
  return globalOn && (taskDirectAccess ?? false);
}

/** Single source of truth for "publish this task's runtime to the user's OWN browser"
 *  (host ports + DDEV custom router ports). It is the per-task `tasks.direct_access`
 *  column (chosen on 01b-browser-access for workflow tasks, 98-choose-view for run_app)
 *  ANDed with the global BROWSER_DIRECT_ACCESS kill-switch.
 *
 *  Default false => DDEV stays on its portless 80/443 router and nothing is published
 *  (VNC-only) — the robust default for apps that hard-code their own hostname/port. Read
 *  at every runner bring-up (startDdevRunner, app-runner) so the decision survives
 *  warm-recover and stays identical across the task's re-ensures. Resolving here, by
 *  taskId, keeps the 10 `ensureDdevStarted` callers param-free. */
export async function resolveTaskDirectAccess(taskId: string): Promise<boolean> {
  // Admin kill-switch first: when direct access is globally off, skip the db read.
  const globalOn = await configService.getBoolean(CONFIG_KEYS.BROWSER_DIRECT_ACCESS, true);
  if (!globalOn) return false;
  const row = await getDb().query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { directAccess: true },
  });
  return decideDirectAccess(globalOn, row?.directAccess);
}
