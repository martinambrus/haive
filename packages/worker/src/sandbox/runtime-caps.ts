import {
  CONFIG_KEYS,
  configService,
  deriveRuntimeCaps,
  logger,
  readHostResources,
  type HostResources,
  type RuntimeCaps,
} from '@haive/shared';
import { getDb } from '../db.js';
import { loadTaskResourceLimits } from './container-manager.js';

// Resolves the effective Docker resource caps for a spawned container from three
// layers: host size (auto-derived), the admin RUNTIME_* config overrides, and a
// per-task tasks.memoryLimitMb/cpuLimitMilli override. Gated by the master
// RESOURCE_LIMITS_ENABLED switch — when off, callers spawn with no cap flags (the
// byte-for-byte pre-feature argv, the rollback).

const log = logger.child({ module: 'runtime-caps' });

// Host RAM/CPU are fixed for the worker's lifetime — read once.
let cachedHost: HostResources | null = null;
function host(): HostResources {
  if (!cachedHost) cachedHost = readHostResources();
  return cachedHost;
}

export interface EffectiveRuntimeCaps {
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

/** `docker run` flag args for a cap set: --memory + --memory-swap (equal, so swap is
 *  disabled inside the container and it OOM-kills instead of driving the host into swap
 *  thrash) + --cpus + --pids-limit. */
export function buildResourceLimitArgs(caps: EffectiveRuntimeCaps): string[] {
  return [
    '--memory',
    `${caps.memoryMb}m`,
    '--memory-swap',
    `${caps.memoryMb}m`,
    '--cpus',
    formatCpus(caps.cpus),
    '--pids-limit',
    String(caps.pidsLimit),
  ];
}

/** docker --cpus wants a decimal; trim trailing zeros so an integer cap reads cleanly. */
function formatCpus(cpus: number): string {
  return Number.isInteger(cpus) ? String(cpus) : cpus.toFixed(3);
}

/** Master kill-switch. Fail-open to false (no caps) when config is unavailable — a
 *  focused smoke without Redis must still spawn. */
export async function resourceLimitsEnabled(): Promise<boolean> {
  try {
    return await configService.getBoolean(CONFIG_KEYS.RESOURCE_LIMITS_ENABLED, true);
  } catch {
    return false;
  }
}

/** Host-derived caps folded with the admin RUNTIME_* overrides. Includes
 *  maxConcurrentRuntimes for the admission gate. Does NOT apply per-task overrides. */
export async function resolveRuntimeCaps(): Promise<RuntimeCaps> {
  const [memoryMb, cpus, maxConcurrent] = await Promise.all([
    configService.getNumber(CONFIG_KEYS.RUNTIME_MEMORY_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_CPUS, 0),
    configService.getNumber(CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES, 0),
  ]);
  const h = host();
  return deriveRuntimeCaps({
    totalMemMb: h.totalMemMb,
    cpuCount: h.cpuCount,
    overrides: { memoryMb, cpus, maxConcurrent },
  });
}

/** Effective per-container caps for a task's runner, or null when the governor is
 *  disabled (caller then spawns with no cap flags). Layers the per-task
 *  tasks.memoryLimitMb/cpuLimitMilli override on top of the derived caps. */
export async function resolveRunnerCaps(taskId: string): Promise<EffectiveRuntimeCaps | null> {
  if (!(await resourceLimitsEnabled())) return null;
  let caps: RuntimeCaps;
  try {
    caps = await resolveRuntimeCaps();
  } catch (err) {
    log.warn({ err }, 'runtime cap resolve failed; spawning without caps');
    return null;
  }
  let memoryMb = caps.perRunnerMemoryMb;
  let cpus = caps.perRunnerCpus;
  try {
    const t = await loadTaskResourceLimits(getDb(), taskId);
    if (t.memoryLimitMb != null) memoryMb = t.memoryLimitMb;
    if (t.cpuLimitMilli != null) cpus = t.cpuLimitMilli / 1000;
  } catch {
    /* no per-task override — keep the derived caps */
  }
  return { memoryMb, cpus, pidsLimit: caps.perRunnerPidsLimit };
}
