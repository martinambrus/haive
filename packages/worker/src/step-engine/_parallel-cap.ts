import { CONFIG_KEYS, configService } from '@haive/shared';

/**
 * The admin-configured max parallel agents/CLI invocations (floored at 1; no
 * upper limit — set per host capacity), defaulting to 3 when config isn't
 * initialized (e.g. focused unit tests). Pairs with `mapWithConcurrency` from
 * @haive/shared to bound in-process fan-outs by the same knob that caps the
 * cli-exec queue.
 */
export async function resolveParallelCap(): Promise<number> {
  try {
    const n = await configService.getNumber(CONFIG_KEYS.MAX_PARALLEL_AGENTS, 3);
    return Math.max(1, Math.floor(n));
  } catch {
    return 3;
  }
}
