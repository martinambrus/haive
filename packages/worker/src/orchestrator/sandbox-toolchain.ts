import type { Database } from '@haive/database';
import { resolveTaskFacets, type ProjectFacetSet } from '@haive/shared/global-kb';
import type { CliProviderRecord } from '../cli-adapters/types.js';
import { peekSandboxImageTag, createSandboxImagePeekBatch } from '../queues/cli-exec/images.js';
import { sandboxToolchainProbe, type SandboxToolchainFact } from '../sandbox/toolchain-probe.js';
import { toolchainEnvironmentMatches } from '../sandbox/toolchain-prompt.js';

export const TOOLCHAIN_DISPATCH_WAIT_MS = 2_500;
const PEEK_BATCH_WIDTH = 2;

export const TOOLCHAIN_PEEK_TTL_MS = 10_000;
export const TOOLCHAIN_PEEK_CACHE_LIMIT = 128;

type Memo<T> = WeakMap<Database, Map<string, { promise: Promise<T>; expiresAt: number }>>;
const facetsMemo: Memo<ProjectFacetSet> = new WeakMap();
const peekMemo: Memo<Awaited<ReturnType<typeof peekSandboxImageTag>>> = new WeakMap();

function memo<T>(store: Memo<T>, db: Database, key: string, load: () => Promise<T>): Promise<T> {
  let entries = store.get(db);
  if (!entries) store.set(db, (entries = new Map()));
  const hit = entries.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  entries.delete(key);
  if (entries.size >= TOOLCHAIN_PEEK_CACHE_LIMIT) entries.delete(entries.keys().next().value!);
  const promise = load().catch((err: unknown) => {
    if (entries.get(key)?.promise === promise) entries.delete(key);
    throw err;
  });
  entries.set(key, { promise, expiresAt: Date.now() + TOOLCHAIN_PEEK_TTL_MS });
  return promise;
}

/** Shared with the global KB's lazy facet read so one dispatch/fan-out reads the task once. */
export function resolveDispatchTaskFacets(db: Database, taskId: string): Promise<ProjectFacetSet> {
  return memo(facetsMemo, db, taskId, () => resolveTaskFacets(db, taskId));
}

/** PHP is the only measured missing-interpreter case. No repository-provided binary names.
 * Both provider fan-out and caller wait are bounded; slow work may finish/cache later but
 * never mutates an already returned result or starts a probe after this batch expires. */
export async function resolveDispatchSandboxToolchain(
  db: Database,
  taskId: string,
  providers: CliProviderRecord[],
  opts: {
    extraEnv?: Record<string, string>;
    waitMs?: number;
    resolveFacets?: () => Promise<ProjectFacetSet>;
  } = {},
): Promise<Record<string, SandboxToolchainFact | null>> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const facts: Record<string, SandboxToolchainFact | null> = {};
  const work = async () => {
    const facets = await (opts.resolveFacets?.() ?? resolveDispatchTaskFacets(db, taskId));
    if (expired || !facets.language.includes('php')) return;
    const batch = createSandboxImagePeekBatch();
    let next = 0;
    const consume = async () => {
      while (next < providers.length) {
        if (expired) return;
        const provider = providers[next++]!;
        if (
          !provider.enabled ||
          !toolchainEnvironmentMatches(provider.wrapperContent, {
            ...provider.envVars,
            ...opts.extraEnv,
          })
        )
          continue;
        try {
          const key = JSON.stringify([
            taskId,
            provider.id,
            provider.name,
            provider.cliVersion,
            provider.sandboxDockerfileExtra,
          ]);
          const image = await memo(peekMemo, db, key, () =>
            peekSandboxImageTag(db, taskId, provider, undefined, batch),
          );
          if (expired) return;
          facts[provider.id] = image ? await sandboxToolchainProbe.get(image.imageId) : null;
        } catch {
          // Advisory only: database, inspect and probe errors add no prompt text.
        }
      }
    };
    await Promise.all(Array.from({ length: PEEK_BATCH_WIDTH }, consume));
  };
  try {
    await Promise.race([
      work().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, opts.waitMs ?? TOOLCHAIN_DISPATCH_WAIT_MS);
      }),
    ]);
    return { ...facts };
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
