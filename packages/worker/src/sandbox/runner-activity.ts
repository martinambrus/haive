import Docker from 'dockerode';
import { appRunnerName, ddevRunnerName } from '@haive/shared';

/** Execs in flight in each runtime runner, by container name. The reaper and every runner exec
 *  run in the worker process, so this count is what the reaper sees. */
const inFlight = new Map<string, number>();
/** Runners a reap decision is being made for. A new exec waits for it, so it never starts under
 *  a removal the reaper decided before seeing it. */
const fences = new Map<string, Set<Promise<void>>>();

const runnerNames = (taskId: string): string[] => [ddevRunnerName(taskId), appRunnerName(taskId)];

/** Runs `run` while the runner counts as busy, which keeps preemption off it. */
export async function whileRunnerBusy<T>(container: string, run: () => Promise<T>): Promise<T> {
  inFlight.set(container, (inFlight.get(container) ?? 0) + 1);
  try {
    for (let held = fences.get(container); held?.size; held = fences.get(container)) {
      await Promise.all(held);
    }
    return await run();
  } finally {
    const left = (inFlight.get(container) ?? 1) - 1;
    if (left > 0) inFlight.set(container, left);
    else inFlight.delete(container);
  }
}

/** Runs `run` while both of the task's runners count as busy: a CLI run drives them from its own
 *  container, so a reap decision must neither start under it nor see it as settled. */
export function whileTaskRunnersBusy<T>(taskId: string, run: () => Promise<T>): Promise<T> {
  return whileRunnerBusy(ddevRunnerName(taskId), () => whileRunnerBusy(appRunnerName(taskId), run));
}

/** Whether either runtime runner of the task has an exec in flight in this process. */
export function taskRunnerBusy(taskId: string): boolean {
  return runnerNames(taskId).some((name) => inFlight.has(name));
}

/** Holds new execs on the task's runners while `decide` runs. `decide` calls `idle()` last, right
 *  before it removes a runner: an exec that arrived meanwhile has registered and makes it false. */
export async function withRunnersFenced<T>(
  taskId: string,
  decide: (idle: () => boolean) => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const fence = new Promise<void>((resolve) => (release = resolve));
  const names = runnerNames(taskId);
  for (const name of names) fences.set(name, (fences.get(name) ?? new Set()).add(fence));
  try {
    return await decide(() => !taskRunnerBusy(taskId));
  } finally {
    for (const name of names) {
      const held = fences.get(name);
      held?.delete(fence);
      if (held?.size === 0) fences.delete(name);
    }
    release();
  }
}

/** Whether Docker still runs an attached exec in either runner of the task. An exec outlives the
 *  worker or client that started it; a detached one (a port forwarder) never ends and is not work. */
export async function runnerExecLive(
  taskId: string,
  docker: Docker = new Docker(),
  timeoutMs = 8_000,
): Promise<boolean> {
  // Runs inside a reap fence, so a daemon that never answers must not hold the runner's execs; the
  // aborted request rejects, which reads as busy.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  try {
    return await attachedExecRunning(taskId, docker, deadline.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function attachedExecRunning(
  taskId: string,
  docker: Docker,
  abortSignal: AbortSignal,
): Promise<boolean> {
  for (const name of runnerNames(taskId)) {
    let execIds: string[];
    try {
      execIds = (await docker.getContainer(name).inspect({ abortSignal })).ExecIDs ?? [];
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) continue;
      return true;
    }
    for (const id of execIds) {
      try {
        const info = await docker.getExec(id).inspect({ abortSignal });
        if (info.Running && info.OpenStdout) return true;
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) return true;
      }
    }
  }
  return false;
}
