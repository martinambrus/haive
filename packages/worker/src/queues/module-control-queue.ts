import { Worker } from 'bullmq';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  MODULE_CONTROL_JOB_NAMES,
  QUEUE_NAMES,
  logger,
  type ModuleTeardownPayload,
  type ModuleTeardownResult,
} from '@haive/shared';
import { openModuleDatabase, type ModuleDatabase } from '@haive/shared/module-db';
import { safeErrorForTransport } from '@haive/shared/logger';
import { getDb } from '../db.js';
import { getBullRedis } from '../redis.js';
import {
  MODULE_JOBS_RECONCILE_MS,
  MODULE_SCHEMA_ENSURE_TIMEOUT_MS,
  beginModuleTeardown,
  moduleJobsStarted,
  moduleTeardownRunning,
  type LoadedWorkerModule,
  type WorkerModuleEntry,
} from '../modules/loader.js';
import { markModuleSchemaReady, markModuleSchemaUnready } from '../modules/schema-ready.js';

const log = logger.child({ module: 'module-control' });

export class ModuleTeardownRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleTeardownRefusedError';
  }
}

class ModuleTeardownEndedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleTeardownEndedError';
  }
}

export const TEARDOWN_HOOK_TIMEOUT_MS = 10 * 60_000;

export type ModuleControlDeps = {
  db: Database;
  loaded: readonly LoadedWorkerModule[];
  entries: readonly WorkerModuleEntry[];
  jobsStarted: (moduleId: string) => boolean;
  teardownRunning: (moduleId: string) => boolean;
  hookTimeoutMs?: number;
};

async function runHook(
  db: Database,
  moduleId: string,
  teardown: NonNullable<WorkerModuleEntry['teardown']>,
  timeoutMs: number,
  release: () => void,
): Promise<void> {
  const opened: ModuleDatabase[] = [];
  // Set when the close pass below begins: a database opened after it would never be closed.
  let ended = false;
  const endedError = (): Error =>
    new ModuleTeardownEndedError(
      `Module ${moduleId}'s teardown job has ended; its hook can no longer open the module database`,
    );
  let timer: NodeJS.Timeout | undefined;
  // A hook that never settles would hold the job, so every later Tear down would wait on it.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Module ${moduleId}'s teardown did not finish within ${Math.round(timeoutMs / 1000)} s`,
          ),
        ),
      timeoutMs,
    );
  });
  const hook = (async () =>
    teardown({
      moduleId,
      logger: logger.child({ module: moduleId }),
      openDatabase: async () => {
        if (ended) throw endedError();
        const moduleDb = await openModuleDatabase(db, moduleId);
        if (ended) {
          await moduleDb.close();
          throw endedError();
        }
        opened.push(moduleDb);
        return moduleDb;
      },
    }))();
  // Only the hook's own end frees the module: past the timeout it may still be dropping data.
  void hook.then(release, release);
  try {
    await Promise.race([hook, timedOut]);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    ended = true;
    await Promise.allSettled(opened.map((moduleDb) => moduleDb.close()));
  }
}

export async function runModuleTeardown(
  deps: ModuleControlDeps,
  moduleId: string,
): Promise<ModuleTeardownResult> {
  const { db } = deps;
  const index = deps.loaded.findIndex((m) => m.manifest.id === moduleId);
  if (index === -1) {
    throw new ModuleTeardownRefusedError(`Module ${moduleId} is not loaded by this worker`);
  }
  const [row] = await db
    .select({ deactivatedAt: schema.modules.deactivatedAt, missingAt: schema.modules.missingAt })
    .from(schema.modules)
    .where(eq(schema.modules.moduleId, moduleId))
    .limit(1);
  if (!row) {
    throw new ModuleTeardownRefusedError(`Module ${moduleId} has no recorded row`);
  }
  if (row.deactivatedAt === null) {
    throw new ModuleTeardownRefusedError(
      `Module ${moduleId} is active; deactivate it before tearing it down`,
    );
  }
  if (row.missingAt !== null) {
    throw new ModuleTeardownRefusedError(
      `Module ${moduleId} is missing: this install no longer carries its code`,
    );
  }
  if (deps.jobsStarted(moduleId)) {
    throw new ModuleTeardownRefusedError(
      `Module ${moduleId}'s jobs or schema setup are still running on this worker; try again once they have ended. Its jobs normally stop within about ${MODULE_JOBS_RECONCILE_MS / 1000} seconds of the deactivation; a schema setup that does not finish is cut off after ${MODULE_SCHEMA_ENSURE_TIMEOUT_MS / 60_000} minutes, and so is a job start that does not return`,
    );
  }
  if (deps.teardownRunning(moduleId)) {
    throw new ModuleTeardownRefusedError(
      `Module ${moduleId}'s earlier teardown is still running on this worker; try again once it has ended`,
    );
  }

  const teardown = deps.entries[index]?.teardown;
  if (teardown) {
    // The jobs reconcile starts nothing of this module while its hook drops data.
    const endTeardown = beginModuleTeardown(moduleId);
    markModuleSchemaUnready(moduleId);
    // With no schema ensure to run again, the end of the hook is all the module waits for.
    const release = deps.entries[index]?.ensureSchema
      ? endTeardown
      : () => {
          endTeardown();
          markModuleSchemaReady(moduleId);
        };
    await runHook(db, moduleId, teardown, deps.hookTimeoutMs ?? TEARDOWN_HOOK_TIMEOUT_MS, release);
  }

  // Conditional: a module activated again while the hook ran must not read as torn down.
  const [stamped] = await db
    .update(schema.modules)
    .set({ tornDownAt: sql`now()` })
    .where(
      and(
        eq(schema.modules.moduleId, moduleId),
        isNotNull(schema.modules.deactivatedAt),
        isNull(schema.modules.missingAt),
      ),
    )
    .returning({ tornDownAt: schema.modules.tornDownAt });
  log.info(
    { moduleId, hook: teardown !== undefined, recorded: stamped !== undefined },
    'module teardown finished',
  );
  return { moduleId, tornDownAt: stamped?.tornDownAt?.toISOString() ?? null };
}

export async function processModuleControlJob(
  deps: ModuleControlDeps,
  job: { name: string; id?: string; data: ModuleTeardownPayload },
): Promise<ModuleTeardownResult> {
  if (job.name !== MODULE_CONTROL_JOB_NAMES.TEARDOWN) {
    throw new Error(`Unknown module-control job: ${job.name}`);
  }
  return runModuleTeardown(deps, job.data.moduleId).catch((err) => {
    throw safeErrorForTransport(err, job);
  });
}

export function startModuleControlWorker(
  modules: Pick<ModuleControlDeps, 'loaded' | 'entries'>,
): Worker<ModuleTeardownPayload, ModuleTeardownResult> {
  const worker = new Worker<ModuleTeardownPayload, ModuleTeardownResult>(
    QUEUE_NAMES.MODULE_CONTROL,
    (job) =>
      processModuleControlJob(
        {
          ...modules,
          db: getDb(),
          jobsStarted: moduleJobsStarted,
          teardownRunning: moduleTeardownRunning,
        },
        job,
      ),
    // A worker that dies mid-hook fails the job instead of running the hook again unasked.
    { connection: getBullRedis(), concurrency: 1, maxStalledCount: 0 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ jobId: job?.id, moduleId: job?.data?.moduleId, err }, 'module-control job failed');
  });
  return worker;
}
