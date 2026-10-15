import { eq } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  lockNewWorkFenceShared,
  logger,
  parseMaintenanceState,
  refusesNewWork,
  type MaintenanceState,
} from '@haive/shared';
import { reviveRefusal } from '@haive/shared/onboarding-admission';

export interface ReviveRefused {
  reason: string;
  otherTaskId?: string;
}

/** Thrown, with nothing written, when a transaction would reopen a failed task during a hold. */
export class NewWorkHeld extends Error {
  constructor(readonly state: MaintenanceState) {
    super(`new work is held while the system is ${state}`);
    this.name = 'NewWorkHeld';
  }
}

/** The stored state, past the config cache since the api that sets it is another process. */
export async function readMaintenanceState(taskId: string): Promise<MaintenanceState> {
  return parseMaintenanceState(
    await configService.getFresh(CONFIG_KEYS.MAINTENANCE_STATE).catch((err: unknown) => {
      logger.warn({ err, taskId }, 'maintenance state unreadable; not held');
      return null;
    }),
  );
}

/** Call first in the transaction that reopens a failed task; a state write waits for its commit. */
export async function admitReopen(tx: DbTx, taskId: string): Promise<void> {
  await lockNewWorkFenceShared(tx);
  const state = await readMaintenanceState(taskId);
  if (!refusesNewWork(state)) return;
  const [task] = await tx
    .select({ status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  if (task?.status === 'failed') throw new NewWorkHeld(state);
}

/** The api's `refuseReviveBesideLive` for the worker: the creation's checks under the repository
 *  lock, then, for an upgrade or rollback, the reset admission on the locked row. Call it after
 *  admitReopen in the transaction that revives a failed task; null if the revival may go ahead. */
export async function refuseRevive(tx: DbTx, taskId: string): Promise<ReviveRefused | null> {
  const verdict = await reviveRefusal(tx, taskId);
  if (!verdict) return null;
  const why = 'refusal' in verdict ? verdict.refusal : verdict.admission;
  return 'taskId' in why ? { reason: why.reason, otherTaskId: why.taskId } : { reason: why.reason };
}
