import {
  CONFIG_KEYS,
  configService,
  deriveRuntimeCaps,
  logger,
  readHostResources,
  type HostResources,
  type RuntimeCaps,
} from '@haive/shared';
import type { Database } from '@haive/database';
import { getDb } from '../db.js';
import { getTaskEnvTemplate } from '../step-engine/steps/env-replicate/_shared.js';
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

/** The host's CPU count (cached with the rest of the host read). Used to bound auto-sized
 *  agent concurrency — RAM is not the only thing an agent consumes. */
export function hostCpuCount(): number {
  return host().cpuCount;
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

/** Which pooled runner a task is bringing up — picks the admission planning weight. */
export type RuntimeKind = 'ddev' | 'app';

/** Docker label stamping the planning weight (MB) a runtime runner was admitted at, so the
 *  admission gate reads occupancy straight off `docker ps` with no `inspect` per container,
 *  and a runner keeps the weight it was budgeted at even if the config changes under it. */
export const RUNTIME_WEIGHT_LABEL = 'haive.runtime.weight.mb';

/** Host-derived caps folded with the admin runtime and agent overrides. Includes the byte
 *  budget and planning weights for the admission gate. Does NOT apply per-task overrides. */
export async function resolveRuntimeCaps(): Promise<RuntimeCaps> {
  const [
    memoryMb,
    cpus,
    maxConcurrent,
    ddevWeightMb,
    appWeightMb,
    agentWeightMb,
    browserWeightMb,
    agentFloor,
  ] = await Promise.all([
    configService.getNumber(CONFIG_KEYS.RUNTIME_MEMORY_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_CPUS, 0),
    configService.getNumber(CONFIG_KEYS.MAX_CONCURRENT_RUNTIMES, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_DDEV_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_APP_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.AGENT_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.RUNTIME_BROWSER_WEIGHT_MB, 0),
    configService.getNumber(CONFIG_KEYS.AGENT_FLOOR, 0),
  ]);
  const h = host();
  return deriveRuntimeCaps({
    totalMemMb: h.totalMemMb,
    cpuCount: h.cpuCount,
    overrides: {
      memoryMb,
      cpus,
      maxConcurrent,
      ddevWeightMb,
      appWeightMb,
      agentWeightMb,
      browserWeightMb,
      agentFloor,
    },
  });
}

/** Planning weight (MB) for THIS task's runner of `kind`. A per-task memory pin wins outright:
 *  that is exactly what the container is allowed to occupy, so budgeting it at a class weight
 *  would under-count a deliberately fattened runner. Otherwise the kind's class weight, plus the
 *  browser surcharge when this task runs browser testing — the headed desktop lives inside the
 *  runner, so a browser task's runner really is heavier than a browser-less one's. Falls back to
 *  the bare class weight when the task rows cannot be read — never to 0, which would make the
 *  runner free. */
export async function resolveRuntimeWeightMb(taskId: string, kind: RuntimeKind): Promise<number> {
  const caps = await resolveRuntimeCaps();
  const classWeight = kind === 'ddev' ? caps.ddevWeightMb : caps.appWeightMb;
  try {
    const db = getDb();
    const t = await loadTaskResourceLimits(db, taskId);
    if (t.memoryLimitMb != null && t.memoryLimitMb > 0) return t.memoryLimitMb;
    return classWeight + ((await taskUsesBrowser(db, taskId)) ? caps.browserWeightMb : 0);
  } catch {
    return classWeight;
  }
}

/** Whether this task's environment runs browser testing — the same `declaredDeps.browserTesting`
 *  flag 07/07b/08a/09 read before calling startBrowserDesktop, so the weight matches what those
 *  steps will actually start inside the runner. */
async function taskUsesBrowser(db: Database, taskId: string): Promise<boolean> {
  const template = await getTaskEnvTemplate(db, taskId);
  if (!template || template.status !== 'ready') return false;
  return !!(template.declaredDeps as Record<string, unknown> | null)?.browserTesting;
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
