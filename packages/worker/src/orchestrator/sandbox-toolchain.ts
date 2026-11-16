import type { Database } from '@haive/database';
import { resolveTaskFacets } from '@haive/shared/global-kb';
import type { CliProviderRecord } from '../cli-adapters/types.js';
import { peekSandboxImageTag } from '../queues/cli-exec/images.js';
import { sandboxToolchainProbe, type SandboxToolchainFact } from '../sandbox/toolchain-probe.js';
import { toolchainEnvironmentMatches } from '../sandbox/toolchain-prompt.js';

export const TOOLCHAIN_DISPATCH_WAIT_MS = 2_500;
const MAX_PEEKS = 2;
let activePeeks = 0;

/** PHP is the only measured missing-interpreter case. No repository-provided binary names.
 * Both provider fan-out and caller wait are bounded; slow work may finish/cache later but
 * never mutates an already returned result or starts a probe after this batch expires. */
export async function resolveDispatchSandboxToolchain(
  db: Database,
  taskId: string,
  providers: CliProviderRecord[],
  opts: { extraEnv?: Record<string, string>; waitMs?: number } = {},
): Promise<Record<string, SandboxToolchainFact | null>> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const facts: Record<string, SandboxToolchainFact | null> = {};
  const work = async () => {
    const facets = await resolveTaskFacets(db, taskId);
    if (expired || !facets.language.includes('php')) return;
    let next = 0;
    const consume = async () => {
      while (next < providers.length) {
        if (expired || activePeeks >= MAX_PEEKS) return;
        const provider = providers[next++]!;
        if (
          !provider.enabled ||
          !toolchainEnvironmentMatches(provider.wrapperContent, {
            ...provider.envVars,
            ...opts.extraEnv,
          })
        )
          continue;
        activePeeks++;
        try {
          const image = await peekSandboxImageTag(db, taskId, provider);
          if (expired) return;
          facts[provider.id] = image ? await sandboxToolchainProbe.get(image.imageId) : null;
        } catch {
          // Advisory only: database, inspect and probe errors add no prompt text.
        } finally {
          activePeeks--;
        }
      }
    };
    await Promise.all(Array.from({ length: MAX_PEEKS }, consume));
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
