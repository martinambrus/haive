import { AsyncLocalStorage } from 'node:async_hooks';
import type { StepDefinition } from '../step-engine/step-definition.js';

// Like stepAdvanceHeld, this relies on the single worker per install. No database
// connection is held over a move. A dead worker loses these leases, leaving its
// committed metadata available to the next worker's sweep.
const scope = new AsyncLocalStorage<Set<string>>();
const active = new Map<string, Set<Set<string>>>();
const recoveries = new Map<string, Promise<void>>();

export async function withProjectionMove<T>(run: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return run();
  const paths = new Set<string>();
  return scope.run(paths, async () => {
    try {
      return await run();
    } finally {
      for (const path of paths) {
        const holders = active.get(path)!;
        holders.delete(paths);
        if (holders.size === 0) active.delete(path);
      }
    }
  });
}

/** Called before capture; the caller's outer move scope owns the lease until it ends. */
export async function holdProjectionMove(path: string): Promise<void> {
  while (recoveries.has(path)) await recoveries.get(path);
  const owner = scope.getStore();
  if (!owner) throw new Error('projection move requires a scope');
  owner.add(path);
  const holders = active.get(path) ?? new Set<Set<string>>();
  holders.add(owner);
  active.set(path, holders);
}

/** The owning move may settle its own metadata; all unrelated recovery waits. */
export function projectionRecoveryHeld(path: string): boolean {
  const owner = scope.getStore();
  return [...(active.get(path) ?? [])].some((held) => held !== owner);
}

/** Keep the lease across the complete apply, including its move and failure recovery. */
export function projectionMoveStep<D, A>(step: StepDefinition<D, A>): StepDefinition<D, A> {
  const apply = step.apply;
  return { ...step, apply: (...args) => withProjectionMove(() => apply(...args)) };
}

/** A restore holds through its guarded SQL clear. A new capture waits before opening
 *  a transaction, so it cannot start between the final lease check and that clear. */
export async function withProjectionRecovery(
  path: string,
  run: () => Promise<boolean>,
): Promise<boolean> {
  while (recoveries.has(path)) await recoveries.get(path);
  if (projectionRecoveryHeld(path)) return false;
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  recoveries.set(path, done);
  try {
    return await run();
  } finally {
    recoveries.delete(path);
    release();
  }
}
