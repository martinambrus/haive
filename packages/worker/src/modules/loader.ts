import type { Redis } from 'ioredis';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import {
  isCoreStepId,
  isModuleStepId,
  MODULES_LOADED_WORKER_KEY,
  moduleManifestSchema,
  modulePackageId,
  type ComposableStepEntry,
  type CompositionIssue,
  type ModuleManifest,
  type ModuleSource,
  type TaskTypeDefaultsIssue,
} from '@haive/shared/modularity';
import {
  openModuleDatabase,
  type ModuleSchemaContext,
  type ModuleTeardownContext,
} from '@haive/shared/module-db';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import type { StepRegistry } from '../step-engine/registry.js';
import type { StepDefinition } from '../step-engine/step-definition.js';
import { emitsLoop } from '../step-engine/steps/index.js';
import { FIX_LOOP_TARGET_STEP_ID } from '../step-engine/steps/workflow/_fix-loop.js';

export type { ModuleSchemaContext, ModuleTeardownContext };

export type ModuleJobContext = {
  moduleId: string;
  connection: Redis;
  logger: ReturnType<typeof logger.child>;
};

export type WorkerModuleEntry = {
  packageName: string;
  source?: ModuleSource;
  manifest: unknown;
  steps?: readonly StepDefinition[];
  ensureSchema?: (ctx: ModuleSchemaContext) => Promise<void>;
  jobs?: (ctx: ModuleJobContext) => Promise<() => Promise<void>>;
  teardown?: (ctx: ModuleTeardownContext) => Promise<void>;
};

export type LoadedWorkerModule = {
  packageName: string;
  source?: ModuleSource;
  manifest: ModuleManifest;
  stepIds: string[];
  composable: ComposableStepEntry[];
};

export type ModuleTaskTypeOutcome = {
  seeded: string[];
  conflicts: { slug: string; heldBy: string }[];
  invalid?: { slug: string; issues: (TaskTypeDefaultsIssue | CompositionIssue)[] }[];
};

const namespaced = (moduleId: string, localId: string) => `module.${moduleId}.${localId}`;

export function registerModuleSteps(
  registry: StepRegistry,
  entries: readonly WorkerModuleEntry[],
): LoadedWorkerModule[] {
  const manifests: ModuleManifest[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = moduleManifestSchema.safeParse(entry.manifest);
    if (!parsed.success) {
      throw new Error(
        `Invalid manifest in module ${entry.packageName}: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    if (modulePackageId(entry.packageName) !== parsed.data.id) {
      throw new Error(
        `Module ${entry.packageName} declares id "${parsed.data.id}"; its package must be named @haive/module-${parsed.data.id} or @haive-module/${parsed.data.id}`,
      );
    }
    if (seen.has(parsed.data.id)) {
      throw new Error(`Duplicate module id "${parsed.data.id}" (${entry.packageName})`);
    }
    seen.add(parsed.data.id);
    manifests.push(parsed.data);
  }

  return entries.map((entry, index) => {
    const manifest = manifests[index]!;
    const moduleId = manifest.id;
    const localDefs = new Map<string, StepDefinition>();
    const stepIds: string[] = [];
    for (const def of entry.steps ?? []) {
      const localId = def.metadata.id;
      if (!isCoreStepId(localId)) {
        throw new Error(`Module ${moduleId} step "${localId}" is not a valid local step id`);
      }
      const id = namespaced(moduleId, localId);
      try {
        registry.register({
          ...def,
          metadata: { ...def.metadata, id, workflowType: `module.${moduleId}` },
        } as StepDefinition);
      } catch (err) {
        throw new Error(
          `Module ${moduleId} cannot register step "${localId}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      localDefs.set(localId, def);
      stepIds.push(id);
    }

    const composable = (manifest.composableSteps ?? []).map((composableEntry) => {
      const def = localDefs.get(composableEntry.stepId);
      if (!def) {
        throw new Error(
          `Module ${moduleId} composable step "${composableEntry.stepId}" is not one of its steps`,
        );
      }
      const named = `Module ${moduleId} composable step "${composableEntry.stepId}"`;
      // The runner still routes loop_back to the core implement step whatever a catalog entry says.
      if (def.reviseLoop) {
        throw new Error(`${named} uses reviseLoop, which cannot be composed yet`);
      }
      if (emitsLoop(def) && composableEntry.loopTargetStepId !== FIX_LOOP_TARGET_STEP_ID) {
        throw new Error(
          `${named} loops back to ${FIX_LOOP_TARGET_STEP_ID}; declare that as loopTargetStepId`,
        );
      }
      if (!emitsLoop(def) && composableEntry.loopTargetStepId !== undefined) {
        throw new Error(`${named} declares a loop target but does not loop`);
      }
      return { ...composableEntry, stepId: namespaced(moduleId, composableEntry.stepId) };
    });

    for (const seed of manifest.taskTypes ?? []) {
      const unregistered = (seed.stepIds ?? []).find(
        (id) => isModuleStepId(id) && !stepIds.includes(id),
      );
      if (unregistered !== undefined) {
        throw new Error(
          `Module ${moduleId} task type "${seed.slug}" step "${unregistered}" is not one of its steps`,
        );
      }
    }

    return { packageName: entry.packageName, source: entry.source, manifest, stepIds, composable };
  });
}

async function bootstrapModuleSchema(
  db: Database,
  moduleId: string,
  ensureSchema: NonNullable<WorkerModuleEntry['ensureSchema']>,
): Promise<void> {
  try {
    const moduleDb = await openModuleDatabase(db, moduleId);
    try {
      await ensureSchema({
        moduleId,
        sql: moduleDb.sql,
        withSchemaLock: moduleDb.withSchemaLock,
      });
    } finally {
      await moduleDb.close();
    }
  } catch (err) {
    throw new Error(
      `Module ${moduleId} schema bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export async function ensureModuleSchemas(
  db: Database,
  loaded: readonly LoadedWorkerModule[],
  entries: readonly WorkerModuleEntry[],
): Promise<Record<string, 'ok' | 'none'>> {
  const result: Record<string, 'ok' | 'none'> = {};
  for (const [index, module] of loaded.entries()) {
    const moduleId = module.manifest.id;
    const ensureSchema = entries[index]?.ensureSchema;
    if (!ensureSchema) {
      result[moduleId] = 'none';
      continue;
    }
    await bootstrapModuleSchema(db, moduleId, ensureSchema);
    result[moduleId] = 'ok';
  }
  return result;
}

const jobsStarted = new Set<string>();
const teardownsRunning = new Set<string>();

export const moduleJobsStarted = (moduleId: string): boolean => jobsStarted.has(moduleId);

export function beginModuleTeardown(moduleId: string): () => void {
  teardownsRunning.add(moduleId);
  return () => {
    teardownsRunning.delete(moduleId);
  };
}

export type ModuleJobsHandle = {
  reconcile: (deactivated: ReadonlySet<string>) => Promise<void>;
  stopAll: () => Promise<void>;
};

export async function startModuleJobs(
  loaded: readonly LoadedWorkerModule[],
  entries: readonly WorkerModuleEntry[],
  deactivated: ReadonlySet<string> = new Set(),
): Promise<ModuleJobsHandle> {
  const stops = new Map<string, () => Promise<void>>();
  const start = async (
    moduleId: string,
    jobs: NonNullable<WorkerModuleEntry['jobs']>,
  ): Promise<void> => {
    const stop = await jobs({
      moduleId,
      connection: getBullRedis(),
      logger: logger.child({ module: moduleId }),
    });
    stops.set(moduleId, stop);
    jobsStarted.add(moduleId);
  };
  const stopModules = async (moduleIds: readonly string[]): Promise<void> => {
    const results = await Promise.allSettled(moduleIds.map(async (id) => stops.get(id)!()));
    results.forEach((r, i) => {
      const moduleId = moduleIds[i]!;
      if (r.status === 'rejected') {
        logger.warn({ err: r.reason, module: moduleId }, 'module jobs failed to stop');
      } else {
        stops.delete(moduleId);
        jobsStarted.delete(moduleId);
        logger.info({ module: moduleId }, 'module jobs stopped');
      }
    });
  };
  const stopAll = (): Promise<void> => stopModules([...stops.keys()]);
  for (const [index, module] of loaded.entries()) {
    const jobs = entries[index]?.jobs;
    if (!jobs) continue;
    const moduleId = module.manifest.id;
    if (deactivated.has(moduleId)) {
      logger.info({ module: moduleId }, 'module jobs not started: the module is deactivated');
      continue;
    }
    try {
      await start(moduleId, jobs);
    } catch (err) {
      await stopAll();
      throw new Error(
        `Module ${moduleId} jobs failed to start: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  const pending = new Set(deactivated);
  const reconcile = async (nowDeactivated: ReadonlySet<string>): Promise<void> => {
    await stopModules([...stops.keys()].filter((moduleId) => nowDeactivated.has(moduleId)));
    for (const [index, module] of loaded.entries()) {
      const jobs = entries[index]?.jobs;
      const moduleId = module.manifest.id;
      if (!jobs || stops.has(moduleId)) continue;
      if (nowDeactivated.has(moduleId)) {
        pending.add(moduleId);
        continue;
      }
      // A module starts once per reactivation, and not while its teardown runs.
      if (!pending.has(moduleId) || teardownsRunning.has(moduleId)) continue;
      pending.delete(moduleId);
      try {
        const ensureSchema = entries[index]?.ensureSchema;
        if (ensureSchema) await bootstrapModuleSchema(getDb(), moduleId, ensureSchema);
        await start(moduleId, jobs);
        logger.info({ module: moduleId }, 'module jobs started: the module is active again');
      } catch (err) {
        logger.error(
          { err, module: moduleId },
          'module jobs failed to start; deactivate and reactivate the module to try again',
        );
      }
    }
  };

  return { reconcile, stopAll };
}

export async function publishWorkerBootReport(
  redis: Redis,
  loaded: readonly LoadedWorkerModule[],
  schemas: Record<string, 'ok' | 'none'>,
  taskTypes: Record<string, ModuleTaskTypeOutcome>,
): Promise<void> {
  await redis.set(
    MODULES_LOADED_WORKER_KEY,
    JSON.stringify({
      at: new Date().toISOString(),
      modules: loaded.map((m) => ({
        id: m.manifest.id,
        packageName: m.packageName,
        version: m.manifest.version,
        stepIds: m.stepIds,
        composableStepIds: m.composable.map((c) => c.stepId),
        ensureSchema: schemas[m.manifest.id] ?? 'none',
        taskTypes: taskTypes[m.manifest.id] ?? { seeded: [], conflicts: [] },
      })),
    }),
  );
}
