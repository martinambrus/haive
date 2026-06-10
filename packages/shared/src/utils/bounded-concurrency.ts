/**
 * Bounded-concurrency helpers. No external dependency (none installed) — a small
 * FIFO limiter that caps how many async tasks run at once. Used to honor the
 * configurable MAX_PARALLEL_AGENTS cap for in-process fan-outs (e.g. DAG coders,
 * the onboarding Promise.all sites) the same way the cli-exec queue caps agent
 * invocations.
 */

export interface BoundedConcurrency {
  /** Run `task` once a slot is free; resolves/rejects with its result. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Create a FIFO bounded-concurrency limiter: at most `limit` tasks run
 * concurrently; the rest queue and start in submission order as slots free.
 * `limit` is clamped to >= 1.
 */
export function createBoundedConcurrency(limit: number): BoundedConcurrency {
  const max = Math.max(1, Math.floor(limit));
  let active = 0;
  const queue: Array<() => void> = [];

  const pump = (): void => {
    if (active >= max) return;
    const start = queue.shift();
    if (!start) return;
    active += 1;
    start();
  };

  function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            pump();
          });
      };
      queue.push(start);
      pump();
    });
  }

  return { run };
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order
 * in the result array. Drop-in replacement for `Promise.all(items.map(fn))` that
 * respects the concurrency cap. Rejects on the first task rejection (like
 * Promise.all; in-flight tasks are not cancelled).
 */
export async function mapWithConcurrency<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const limiter = createBoundedConcurrency(limit);
  const results = new Array<O>(items.length);
  await Promise.all(
    items.map((item, index) =>
      limiter.run(async () => {
        results[index] = await fn(item, index);
      }),
    ),
  );
  return results;
}
