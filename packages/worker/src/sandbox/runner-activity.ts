import { appRunnerName, ddevRunnerName } from '@haive/shared';

/** Execs in flight in each runtime runner, by container name. The reaper and every runner exec
 *  run in the worker process, so this count is what the reaper sees. */
const inFlight = new Map<string, number>();

/** Runs `run` while the runner counts as busy, which keeps preemption off it. */
export async function whileRunnerBusy<T>(container: string, run: () => Promise<T>): Promise<T> {
  inFlight.set(container, (inFlight.get(container) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const left = (inFlight.get(container) ?? 1) - 1;
    if (left > 0) inFlight.set(container, left);
    else inFlight.delete(container);
  }
}

/** Whether either runtime runner of the task has an exec in flight. */
export function taskRunnerBusy(taskId: string): boolean {
  return inFlight.has(ddevRunnerName(taskId)) || inFlight.has(appRunnerName(taskId));
}
