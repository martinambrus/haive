import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, TASK_JOB_NAMES, type WorkflowType } from '@haive/shared';
import {
  assertExecutionContractSupported,
  ExecutionContractError,
  executionContractPaths,
  mergePromptStepCatalog,
  moduleManifestSchema,
  parseExecutionContract,
  resolveTaskTypeAvailability,
  type ExecutionPredicateDeclaration,
} from '@haive/shared/modularity';
import { readStepCatalog } from '@haive/shared/modularity-server';
import { z } from 'zod';
import {
  deadTaskResolution,
  reconcileDeadTasks,
  reviveDeadTask,
} from '../src/queues/dead-task-boot.js';
import type { DeadTaskBootDeps, DeadTaskView } from '../src/queues/dead-task-boot.js';
import { redriveStalledTasks, type StalledRedriveDeps } from '../src/queues/stalled-redrive.js';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';
import { advanceGuardSpan } from '../src/step-engine/guard-span-skip.js';
import { StepRegistry, stepRegistry } from '../src/step-engine/registry.js';
import { registerModuleSteps } from '../src/modules/loader.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { rolePlan } from './replacement-fixtures.js';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: '',
  pauseOn: false,
  adds: [] as { name: string; data: Record<string, unknown> }[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../api/src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../../api/src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireAuth: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', h.userId);
    c.set('userRole', 'admin');
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../api/src/queues.js', () => ({ getTaskQueue: () => ({ add: async () => {} }) }));
vi.mock('../../api/src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getBullRedis: () => ({}),
  getRedis: () => ({ scan: async () => ['0', []], del: async () => 0 }),
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: Record<string, unknown>) {
      h.adds.push({ name, data });
    }
  },
}));
vi.mock('../src/sandbox/sandbox-kill.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-kill.js')>()),
  killCliSandboxesForTask: async () => 0,
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/task-auth-volume.js')>()),
  cleanupTaskAuthVolumes: async () => ({ removed: [], failed: [] }),
  syncRefreshedAuthToUserVolumes: async () => undefined,
}));
vi.mock('../src/sandbox/ollama-provision.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ollama-provision.js')>()),
  unloadTaskOllamaCliModels: async () => undefined,
}));
vi.mock('@haive/shared/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/rag')>()),
  resolveTaskEmbedTarget: async () => null,
}));
vi.mock('../src/step-engine/guard-span-skip.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/step-engine/guard-span-skip.js')>();
  return { ...real, advanceGuardSpan: vi.fn(real.advanceGuardSpan) };
});

const url = process.env.GUARD_GATES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/guard_gates_test'))
  throw new Error('Use a dedicated guard_gates_test database');

const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const { Hono } = apiRequire('hono');
const apiPath = (rel: string) => new URL(`../../api/src/${rel}`, import.meta.url).pathname;

const EMAIL_INDEX = 'guard-gates-test-user';
const IDS = ['gg-plan', 'gg-a', 'gg-b', 'gg-report'];
const ENTRY = 'gg-a';
const MODULE_TARGET = 'module.gg.repair';
const MINING_TARGET = 'module.gg.mining';
const DEAD_AT = new Date('2026-10-14T08:00:00.000Z');
const ADVANCE = TASK_JOB_NAMES.ADVANCE_STEP;
const START = TASK_JOB_NAMES.START;
const MAX_JOBS = 40;
const EPOCH = 3;
const REFUSAL_CODE = 'invalid-execution-contract';

const span = (predicateId: string) => ({
  id: 'span',
  firstStepId: ENTRY,
  lastStepId: 'gg-b',
  predicateId,
  args: {},
});
const guarded = (predicateId: string) => ({ version: 1, guardedSpans: [span(predicateId)] });
const EMPTY = { version: 1, guardedSpans: [] };

type Verdict = {
  availability: 'available' | 'refused';
  create: 'admitted' | 'refused';
  apiStart: 'admitted' | 'refused';
  apiRetry: 'admitted' | 'refused';
  apiLift: 'admitted' | 'refused';
  workerStart: 'runs' | 'runs-no-guard-call' | 'dead-once';
  workerAdvance: 'runs' | 'dead-once';
  boot: 'untouched' | 'dead';
  revive: 'revives' | 'refused';
  stalled: 'redriven' | 'excluded';
};
type Strategy = 'static' | 'derived' | 'workflow_paths';
interface Shape {
  name: string;
  contract: unknown;
  strategy: Strategy;
  snapshot: string[] | null;
  derivedTask?: boolean;
  namedFixRefusal?: string;
  expected: Verdict;
}

// The gates do not all see the same inputs, and that is by design. Availability and create judge
// the type definition against the API predicate registry and the stored step catalog. The API
// stored-pin gates (START, every re-entry, the global-pause lift) see only the pin on the task
// row, so they admit whatever the pin alone proves. The worker is authoritative: it alone knows
// the run list strategy, the derived plan, the snapshot and which predicates its steps provide,
// so it marks the task dead (pin kept) for anything it cannot run, and boot and revival repeat
// that judgement. A shape the API admits and the worker kills is the intended asymmetry, not a
// disagreement; non-module fix targets and malformed pins are refused by every gate.
const API_ADMITS = {
  apiStart: 'admitted',
  apiRetry: 'admitted',
  apiLift: 'admitted',
} as const;
const API_REFUSES = {
  apiStart: 'refused',
  apiRetry: 'refused',
  apiLift: 'refused',
} as const;
const WORKER_KILLS = {
  workerStart: 'dead-once',
  workerAdvance: 'dead-once',
  boot: 'dead',
  revive: 'refused',
  stalled: 'excluded',
} as const;
const WORKER_RUNS = {
  workerAdvance: 'runs',
  boot: 'untouched',
  revive: 'revives',
  stalled: 'redriven',
} as const;
const FIX_TARGET_REFUSED: Verdict = {
  availability: 'refused',
  create: 'refused',
  ...API_REFUSES,
  ...WORKER_KILLS,
};

const SHAPES: Shape[] = [
  {
    name: 'supported guarded pin',
    contract: guarded('module.gg.guard'),
    strategy: 'static',
    snapshot: IDS,
    expected: {
      availability: 'available',
      create: 'admitted',
      ...API_ADMITS,
      workerStart: 'runs',
      ...WORKER_RUNS,
    },
  },
  {
    name: 'supported module fix target',
    contract: { ...EMPTY, fixTarget: { stepId: MODULE_TARGET, capabilityVersion: 1 } },
    strategy: 'static',
    snapshot: [...IDS, MODULE_TARGET],
    expected: {
      availability: 'available',
      create: 'admitted',
      ...API_ADMITS,
      workerStart: 'runs-no-guard-call',
      ...WORKER_RUNS,
    },
  },
  {
    name: 'mining step declaring fixConsumer is not a capable fix target',
    contract: { ...EMPTY, fixTarget: { stepId: MINING_TARGET, capabilityVersion: 1 } },
    strategy: 'static',
    snapshot: [...IDS, MINING_TARGET],
    namedFixRefusal: MINING_TARGET,
    // Stored-pin re-entry knows no executable metadata; locked create uses the catalog.
    expected: { availability: 'refused', create: 'refused', ...API_ADMITS, ...WORKER_KILLS },
  },
  {
    name: 'entry at first index',
    contract: {
      version: 1,
      guardedSpans: [{ ...span('module.gg.guard'), firstStepId: IDS[0]! }],
    },
    strategy: 'static',
    snapshot: IDS,
    expected: { availability: 'refused', create: 'refused', ...API_ADMITS, ...WORKER_KILLS },
  },
  {
    name: 'non-module fix target on the run list',
    contract: { ...EMPTY, fixTarget: { stepId: ENTRY, capabilityVersion: 1 } },
    strategy: 'static',
    snapshot: IDS,
    expected: FIX_TARGET_REFUSED,
  },
  {
    name: 'non-module fix target off the run list',
    contract: { ...EMPTY, fixTarget: { stepId: 'gg-missing', capabilityVersion: 1 } },
    strategy: 'static',
    snapshot: IDS,
    expected: FIX_TARGET_REFUSED,
  },
  {
    name: 'malformed version 99',
    contract: { version: 99 },
    strategy: 'static',
    snapshot: IDS,
    expected: FIX_TARGET_REFUSED,
  },
  {
    name: 'guarded on a derived task',
    contract: guarded('module.gg.guard'),
    strategy: 'derived',
    snapshot: IDS,
    derivedTask: true,
    expected: { availability: 'refused', create: 'refused', ...API_ADMITS, ...WORKER_KILLS },
  },
  {
    name: 'guarded on a null snapshot (workflow_paths)',
    contract: guarded('module.gg.guard'),
    strategy: 'workflow_paths',
    snapshot: null,
    // Boot judges a snapshot-less task that carries a contract, so it agrees with the workers.
    expected: { availability: 'refused', create: 'refused', ...API_ADMITS, ...WORKER_KILLS },
  },
  {
    name: 'guarded with a predicate only the API registers',
    contract: guarded('module.gg.apionly'),
    strategy: 'static',
    snapshot: IDS,
    expected: { availability: 'available', create: 'admitted', ...API_ADMITS, ...WORKER_KILLS },
  },
  {
    name: 'guarded with a predicate nobody registers',
    contract: guarded('module.gg.nowhere'),
    strategy: 'static',
    snapshot: IDS,
    expected: { availability: 'refused', create: 'refused', ...API_ADMITS, ...WORKER_KILLS },
  },
  {
    name: 'empty contract',
    contract: EMPTY,
    strategy: 'static',
    snapshot: IDS,
    expected: {
      availability: 'available',
      create: 'admitted',
      ...API_ADMITS,
      workerStart: 'runs-no-guard-call',
      ...WORKER_RUNS,
    },
  },
  {
    name: 'no contract',
    contract: null,
    strategy: 'static',
    snapshot: IDS,
    expected: {
      availability: 'available',
      create: 'admitted',
      ...API_ADMITS,
      workerStart: 'runs-no-guard-call',
      ...WORKER_RUNS,
    },
  },
];
const slugOf = (index: number) => `gg_shape_${index}`;
const BASE_SLUG = 'gg_base';

const ran = { apply: [] as string[] };
const evaluate = vi.fn(async () => true);
const predicate = { argsSchema: z.strictObject({}), evaluate };

function stub(id: string, index: number): StepDefinition {
  return {
    metadata: {
      id,
      workflowType: 'module.gg' as WorkflowType,
      index,
      title: id,
      description: 'guard gate agreement stub',
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    async apply() {
      ran.apply.push(id);
      return {};
    },
    ...(id === IDS[0] ? { guardPredicates: { guard: predicate } } : {}),
    ...([MODULE_TARGET, MINING_TARGET].includes(id)
      ? { fixConsumer: { version: 1 }, editsCodeOrTests: true }
      : {}),
    ...(id === MINING_TARGET ? { agentMining: {} } : {}),
  } as StepDefinition;
}

const job = (name: string, data: Record<string, unknown>) =>
  ({
    id: randomUUID(),
    name,
    data,
    timestamp: Date.now(),
    moveToDelayed: async () => undefined,
  }) as unknown as Parameters<typeof processTaskJob>[0];

type Row = typeof schema.taskSteps.$inferSelect;
type TaskInsert = Partial<typeof schema.tasks.$inferInsert>;
type ApiRefusal = { status: number; code?: string };
const isHttp = (e: unknown): e is ApiRefusal =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number';

describe('one policy: gates share the fence rather than copying it', () => {
  const sourceRoot = (pkg: string) => new URL(`../../${pkg}/src/`, import.meta.url).pathname;
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : /\.tsx?$/.test(entry.name)
          ? [path.join(dir, entry.name)]
          : [],
    );
  const referencing = (pkg: string, word: RegExp) => {
    const root = sourceRoot(pkg);
    return files(root)
      .filter((file) => word.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
      .sort();
  };
  const USABLE = /\bassertExecutionContractUsable\b/;
  const API_SITES: Record<string, number> = {
    'lib/task-start.ts': 1,
    'routes/admin.ts': 1,
    'routes/maintenance.ts': 1,
    'routes/tasks/index.ts': 3,
    'routes/tasks/steps.ts': 5,
  };

  it('the api owns one copy of the shared fence call', () => {
    expect(referencing('api', /\bassertExecutionContractSupported\b/)).toEqual([
      'lib/execution-contract-admission.ts',
    ]);
  });

  it('every api re-entry gate calls the one admission function and nothing else does', () => {
    const sites = referencing('api', USABLE).filter(
      (file) => file !== 'lib/execution-contract-admission.ts',
    );
    expect(sites).toEqual(Object.keys(API_SITES).sort());
    let total = 0;
    for (const [file, minimum] of Object.entries(API_SITES)) {
      const calls = readFileSync(path.join(sourceRoot('api'), file), 'utf8').match(
        /\bassertExecutionContractUsable\(/g,
      );
      expect(calls?.length ?? 0, file).toBeGreaterThanOrEqual(minimum);
      total += calls?.length ?? 0;
    }
    expect(total).toBeGreaterThanOrEqual(11);
  });

  it('the worker fence is called only by the run-list builder and the dead-task judge', () => {
    expect(
      referencing('worker', /\bassertWorkerExecutionContractSupported\b/).filter(
        (file) => file !== 'step-engine/execution-contract-support.ts',
      ),
    ).toEqual(['queues/dead-task-boot.ts', 'queues/run-list.ts']);
  });
});

describe.skipIf(!url)('every gate agrees on the same pin, on Postgres', () => {
  let db: Database;
  let userId: string;
  let repositoryId: string;
  let definitionForCreate: (
    handle: unknown,
    slug: string,
    opts: { generic: boolean; locked: boolean },
  ) => Promise<unknown>;
  let markQueuedForStart: (db: unknown, taskId: string) => Promise<unknown>;
  let retryTaskAtStep: (
    db: Database,
    taskId: string,
    userId: string,
    target: Row,
  ) => Promise<unknown>;
  let executionPredicates: () => ReadonlyMap<string, ExecutionPredicateDeclaration>;
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    vi.spyOn(configService, 'getFresh').mockImplementation(async (key: string) =>
      key === CONFIG_KEYS.GLOBAL_PAUSE && h.pauseOn ? 'true' : 'normal',
    );
    vi.spyOn(configService, 'getBoolean').mockImplementation(
      async (key: string) => key === CONFIG_KEYS.CUSTOM_TASK_TYPES_ENABLED,
    );
    vi.spyOn(configService, 'set').mockResolvedValue(undefined as never);
    ({ definitionForCreate } = await import(apiPath('lib/task-type-definition.ts')));
    ({ markQueuedForStart } = await import(apiPath('lib/task-start.ts')));
    ({ retryTaskAtStep } = await import(apiPath('routes/tasks/steps.ts')));
    const registry = await import(apiPath('modules/execution-predicates.ts'));
    ({ executionPredicates } = registry);
    registry.registerModuleExecutionPredicates(
      [
        {
          executionPredicates: [
            { id: 'guard', argsSchema: z.strictObject({}) },
            { id: 'apionly', argsSchema: z.strictObject({}) },
          ],
        },
      ],
      [
        {
          manifest: moduleManifestSchema.parse({
            id: 'gg',
            name: 'Gg',
            version: '1',
            schemaVersion: 1,
          }),
        },
      ],
    );
    const { adminRoutes } = await import(apiPath('routes/admin.ts'));
    const { errorHandler } = await import(apiPath('middleware/error-handler.ts'));
    app = new Hono();
    (app as unknown as { route: (p: string, r: unknown) => void }).route('/admin', adminRoutes);
    (app as unknown as { onError: (h: unknown) => void }).onError(errorHandler);

    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'guard-gates-test@test.local',
        emailBlindIndex: EMAIL_INDEX,
        passwordHash: 'not-real',
        role: 'admin',
        status: 'active',
        tokenVersion: 0,
      })
      .returning();
    userId = user!.id;
    h.userId = userId;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'guard-gates',
        source: 'local_path',
        localPath: os.tmpdir(),
        storagePath: os.tmpdir(),
        status: 'ready',
      })
      .returning();
    repositoryId = repo!.id;

    await db.insert(schema.modules).values({
      moduleId: 'gg',
      packageName: '@haive/module-gg',
      name: 'Gg',
      installedVersion: '1',
    });
    const moduleRegistry = new StepRegistry();
    const [loaded] = registerModuleSteps(moduleRegistry, [
      {
        packageName: '@haive/module-gg',
        manifest: {
          id: 'gg',
          name: 'Gg',
          version: '1',
          schemaVersion: 1,
          composableSteps: ['repair', 'mining'].map((stepId) => ({
            stepId,
            label: stepId,
            group: 'gg',
            requires: [],
            provides: [],
            dispatchesCli: false,
            fixConsumer: { version: 1 },
          })),
        },
        steps: [MODULE_TARGET, MINING_TARGET].map((id, index) => {
          const def = stub(id, IDS.length + index);
          return { ...def, metadata: { ...def.metadata, id: id.split('.').at(-1)! } };
        }),
      },
    ]);
    await syncStepCatalog(
      db,
      moduleRegistry,
      new Map(loaded!.composable.map((entry) => [entry.stepId, entry])),
    );
    for (const [index, stepId] of IDS.entries())
      await db
        .insert(schema.stepCatalog)
        .values({
          stepId,
          source: stepId === MODULE_TARGET ? 'module:gg' : 'core',
          title: stepId,
          workflowType: 'gg',
          stepIndex: index + 1,
          dispatchesCli: false,
          allowSkip: false,
          providerSensitive: false,
          composable: true,
          entry: {
            stepId,
            label: stepId,
            group: 'gg',
            requires: [],
            provides: [],
            dispatchesCli: false,
            ...(stepId === MODULE_TARGET ? { fixConsumer: { version: 1 } } : {}),
          },
        })
        .onConflictDoNothing();
    const definition = {
      source: 'admin',
      enabled: true,
      selectable: true,
      requiresRepository: false,
      preAnswerDefaults: {},
      stepLoopLimitDefaults: {},
      promptSteps: {},
    };
    await db
      .insert(schema.taskTypeDefinitions)
      .values({
        ...definition,
        slug: BASE_SLUG,
        displayName: BASE_SLUG,
        runListStrategy: 'static',
        stepIds: IDS,
      })
      .onConflictDoNothing();
    for (const [index, shape] of SHAPES.entries())
      await db
        .insert(schema.taskTypeDefinitions)
        .values({
          ...definition,
          slug: slugOf(index),
          displayName: slugOf(index),
          runListStrategy: shape.strategy,
          stepIds: shape.strategy === 'static' ? shape.snapshot : null,
          ...(shape.strategy === 'derived' ? { baseSlug: BASE_SLUG, changes: [] } : {}),
          executionContract: shape.contract,
        })
        .onConflictDoNothing();
    [...IDS, MODULE_TARGET, MINING_TARGET].forEach((id, index) =>
      stepRegistry.override(stub(id, index)),
    );
    setContainerCleanupRunner(async () => 0);
  });

  afterAll(async () => {
    setContainerCleanupRunner(null);
    if (db) {
      await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
      await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, userId));
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, EMAIL_INDEX));
      await db
        .delete(schema.taskTypeDefinitions)
        .where(eq(schema.taskTypeDefinitions.source, 'admin'));
      await db.delete(schema.stepCatalog).where(eq(schema.stepCatalog.workflowType, 'gg'));
      await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'gg'));
      await db.$client.end({ timeout: 5 });
    }
    vi.restoreAllMocks();
  });

  const reset = async () => {
    h.adds.length = 0;
    ran.apply.length = 0;
    evaluate.mockClear();
    vi.mocked(advanceGuardSpan).mockClear();
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
  };
  const make = async (index: number, over: TaskInsert = {}): Promise<string> => {
    const shape = SHAPES[index]!;
    await reset();
    const [made] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: slugOf(index),
        title: 'guard gates',
        metadata: { anchorRepositoryId: null },
        status: 'queued',
        orchestrationEpoch: EPOCH,
        runListSnapshot: shape.snapshot,
        executionContract: shape.contract,
        derivedRunPlan: shape.derivedTask ? rolePlan(1) : null,
        dataEdgePlan: null,
        ...over,
      })
      .returning({ id: schema.tasks.id });
    return made!.id;
  };
  const task = async (id: string) =>
    (await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!;
  const events = (id: string, type: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(and(eq(schema.taskEvents.taskId, id), eq(schema.taskEvents.eventType, type)));
  const stepRow = async (taskId: string, stepId: string, over: Partial<Row> = {}) => {
    const [made] = await db
      .insert(schema.taskSteps)
      .values({
        taskId,
        stepId,
        title: stepId,
        stepIndex: [...IDS, MODULE_TARGET].indexOf(stepId),
        runSeq: [...IDS, MODULE_TARGET].indexOf(stepId),
        round: 0,
        status: 'pending',
        ...over,
      })
      .returning();
    return made!;
  };
  const pump = async () => {
    let processed = 0;
    for (;;) {
      const next = h.adds.shift();
      if (!next) return;
      if (next.name !== ADVANCE) continue;
      if (++processed > MAX_JOBS) throw new Error(`more than ${MAX_JOBS} jobs ran`);
      await processTaskJob(job(next.name, next.data));
    }
  };
  const apiVerdict = async (call: () => Promise<unknown>): Promise<'admitted' | 'refused'> => {
    try {
      await call();
      return 'admitted';
    } catch (error) {
      if (isHttp(error) && error.status === 409 && error.code === REFUSAL_CODE) return 'refused';
      throw error;
    }
  };
  const deadOnce = async (id: string) => {
    const dead = await task(id);
    const count = (await events(id, 'task.dead')).length;
    if (dead.deadAt === null) return count === 0 ? 'alive' : 'alive-with-dead-event';
    const namedTarget = SHAPES.find((_, index) => slugOf(index) === dead.type)?.namedFixRefusal;
    if (namedTarget) expect(dead.deadReason).toContain(namedTarget);
    return count === 1 ? 'dead-once' : `dead-${count}-events`;
  };

  const gates: Record<keyof Verdict | 'shared', (index: number) => Promise<string>> = {
    async shared(index) {
      const shape = SHAPES[index]!;
      if (shape.contract == null) return 'supported';
      const stored = await readStepCatalog(db, { ordered: true });
      try {
        assertExecutionContractSupported(shape.contract, {
          staticPinnedList: shape.strategy === 'static',
          stepIds: shape.snapshot ?? undefined,
        });
        executionContractPaths(
          shape.snapshot ?? [],
          stored.composable,
          parseExecutionContract(shape.contract),
          executionPredicates(),
        );
        return 'supported';
      } catch (error) {
        if (!(error instanceof ExecutionContractError)) throw error;
        if (shape.namedFixRefusal) expect(error.message).toContain(shape.namedFixRefusal);
        return 'refused';
      }
    },
    async availability(index) {
      const shape = SHAPES[index]!;
      const [def] = await db
        .select()
        .from(schema.taskTypeDefinitions)
        .where(eq(schema.taskTypeDefinitions.slug, slugOf(index)));
      const stored = await readStepCatalog(db, { ordered: true });
      const result = resolveTaskTypeAvailability({
        definition: def!,
        switches: { customEnabled: true, moduleEnabled: true },
        modules: new Map([['gg', { name: 'Gg', missing: false, deactivated: false }]]),
        catalog: stored.synced ? mergePromptStepCatalog(stored, def!) : null,
        generic: false,
        predicates: executionPredicates(),
        ...(shape.strategy === 'derived' ? { derived: { stepIds: IDS, valid: true } } : {}),
      });
      if (result.available) return 'available';
      const named = result.issues?.some((issue) => issue.kind === REFUSAL_CODE) === true;
      if (!named) throw new Error(`refused for ${result.reason}, not the execution contract`);
      if (shape.namedFixRefusal)
        expect(result.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: REFUSAL_CODE,
              reason: expect.stringContaining(shape.namedFixRefusal),
            }),
          ]),
        );
      return 'refused';
    },
    async create(index) {
      await reset();
      try {
        await db.transaction((tx) =>
          definitionForCreate(tx, slugOf(index), { generic: false, locked: true }),
        );
        return 'admitted';
      } catch (error) {
        if (isHttp(error) && error.status === 409 && error.code === REFUSAL_CODE) {
          if (SHAPES[index]!.namedFixRefusal)
            expect(error).toHaveProperty(
              'message',
              expect.stringContaining(SHAPES[index]!.namedFixRefusal!),
            );
          return 'refused';
        }
        throw error;
      }
    },
    async apiStart(index) {
      const id = await make(index, { status: 'created' });
      return apiVerdict(async () => {
        const queued = await markQueuedForStart(db, id);
        if (!queued) throw new Error('START changed nothing');
      });
    },
    async apiRetry(index) {
      const id = await make(index, { status: 'failed', currentStepId: IDS[0]! });
      const target = await stepRow(id, IDS[0]!, { status: 'failed' });
      return apiVerdict(() => retryTaskAtStep(db, id, userId, target));
    },
    async apiLift(index) {
      const id = await make(index, { status: 'queued' });
      h.pauseOn = true;
      try {
        const res = await app.request('/admin/config/global-pause', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paused: false }),
        });
        expect(res.status, await res.clone().text()).toBe(200);
        const body = (await res.json()) as { skippedTasks?: { taskId: string; code: string }[] };
        const listed = (body.skippedTasks ?? []).filter((s) => s.taskId === id);
        const held = (await task(id)).pausedAt !== null;
        expect(listed.length > 0, 'listed in skippedTasks iff held').toBe(held);
        for (const entry of listed) expect(entry.code).toBe(REFUSAL_CODE);
        return held ? 'refused' : 'admitted';
      } finally {
        h.pauseOn = false;
      }
    },
    async workerStart(index) {
      const id = await make(index);
      await processTaskJob(job(START, { taskId: id, userId }));
      let state = await deadOnce(id);
      if (state === 'dead-once') {
        await processTaskJob(job(START, { taskId: id, userId }));
        state = await deadOnce(id);
        expect((await task(id)).executionContract).toEqual(SHAPES[index]!.contract);
        return state;
      }
      await pump();
      if ((await task(id)).status !== 'completed') return `not-completed:${state}`;
      return vi.mocked(advanceGuardSpan).mock.calls.length === 0 ? 'runs-no-guard-call' : 'runs';
    },
    async workerAdvance(index) {
      const id = await make(index, { status: 'running', currentStepId: IDS[0]! });
      await stepRow(id, IDS[0]!);
      const payload = { taskId: id, userId, stepId: IDS[0]!, round: 0, epoch: EPOCH };
      await processTaskJob(job(ADVANCE, payload));
      let state = await deadOnce(id);
      if (state === 'dead-once') {
        await processTaskJob(job(ADVANCE, payload));
        return deadOnce(id);
      }
      return state === 'alive' && ran.apply.includes(IDS[0]!) ? 'runs' : `not-run:${state}`;
    },
    async boot(index) {
      const id = await make(index, { status: 'running', currentStepId: IDS[0]! });
      await reconcileDeadTasks(db, bootDeps());
      const state = await deadOnce(id);
      return state === 'dead-once' ? 'dead' : state === 'alive' ? 'untouched' : state;
    },
    async revive(index) {
      const id = await make(index, {
        status: 'running',
        currentStepId: IDS[0]!,
        deadAt: DEAD_AT,
        deadReason: 'seeded',
      });
      const before = await task(id);
      if (SHAPES[index]!.namedFixRefusal)
        expect(deadTaskResolution(before, SHAPES[index]!.strategy).supportReason).toContain(
          SHAPES[index]!.namedFixRefusal,
        );
      const view: DeadTaskView = {
        id,
        userId,
        epoch: before.orchestrationEpoch,
        currentStepId: before.currentStepId,
        currentRound: before.currentRound,
        deadAt: before.deadAt,
        deadReason: before.deadReason,
      };
      const outcome = await reviveDeadTask(db, view, bootDeps());
      if (outcome === 'held') return 'held';
      const after = await task(id);
      if (outcome === null)
        return JSON.stringify(after) === JSON.stringify(before) ? 'refused' : 'changed';
      return after.deadAt === null ? 'revives' : 'revived-but-dead';
    },
    async stalled(index) {
      const id = await make(index);
      await processTaskJob(job(START, { taskId: id, userId }));
      const started = await task(id);
      if (started.deadAt !== null) {
        h.adds.length = 0;
        await age(id);
        const swept = await redriveStalledTasks(db, stalledDeps(), { staleMs: 0 });
        return swept === 0 && h.adds.length === 0 ? 'excluded' : `swept-${swept}`;
      }
      if (started.currentStepId !== ENTRY) return `pointer-${started.currentStepId}`;
      const existing = await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, id));
      for (const stepId of SHAPES[index]!.snapshot ?? IDS)
        if (!existing.some((r) => r.stepId === stepId && r.round === 0))
          await stepRow(id, stepId, { round: 0 });
      h.adds.length = 0;
      await age(id);
      const swept = await redriveStalledTasks(db, stalledDeps(), { staleMs: 0 });
      await pump();
      return swept === 1 && (await task(id)).status === 'completed'
        ? 'redriven'
        : `swept-${swept}-${(await task(id)).status}`;
    },
  };

  const bootDeps = (): DeadTaskBootDeps => ({
    enqueueStart: async (taskId, uid) => {
      h.adds.push({ name: START, data: { taskId, userId: uid } });
    },
    enqueueAdvance: async (taskId, uid, stepId, round, epoch) => {
      h.adds.push({ name: ADVANCE, data: { taskId, userId: uid, stepId, round, epoch } });
    },
    redriveRetryDelaysMs: [],
  });
  const stalledDeps = (): StalledRedriveDeps => ({
    enqueueAdvance: async (taskId, uid, stepId, round, epoch) => {
      h.adds.push({ name: ADVANCE, data: { taskId, userId: uid, stepId, round, epoch } });
    },
    failTask: async () => true,
    enqueueStart: async (taskId, uid) => {
      h.adds.push({ name: START, data: { taskId, userId: uid } });
    },
    queuedTaskJobs: async () => ({ steps: new Set(), starts: new Set() }),
    queuedInvocationIds: async () => new Set(),
    redriveRetryDelaysMs: [],
  });
  const age = async (taskId: string) => {
    const old = new Date(Date.now() - 60_000);
    await db.update(schema.tasks).set({ updatedAt: old }).where(eq(schema.tasks.id, taskId));
    await db
      .update(schema.taskSteps)
      .set({ updatedAt: old })
      .where(eq(schema.taskSteps.taskId, taskId));
  };

  it.each(SHAPES.map((shape, index) => [shape.name, index] as const))(
    'one verdict row for %s',
    async (_name, index) => {
      const verdict: Record<string, string> = {};
      for (const [gate, run] of Object.entries(gates) as [
        keyof typeof gates,
        (i: number) => Promise<string>,
      ][]) {
        try {
          verdict[gate] = await run(index);
        } catch (error) {
          verdict[gate] = `error:${error instanceof Error ? error.name : typeof error}`;
        }
      }
      expect(verdict).toEqual({
        shared: SHAPES[index]!.expected.availability === 'available' ? 'supported' : 'refused',
        ...SHAPES[index]!.expected,
      });
    },
    60_000,
  );

  it('a dead predicate-less pin stays dead across two boot passes', async () => {
    const index = SHAPES.findIndex((s) => s.name.includes('only the API registers'));
    const id = await make(index, {
      status: 'running',
      currentStepId: IDS[0]!,
      deadAt: DEAD_AT,
      deadReason: 'seeded',
    });
    const before = await task(id);
    for (let pass = 0; pass < 2; pass++) {
      await expect(reconcileDeadTasks(db, bootDeps())).resolves.toMatchObject({
        marked: 0,
        revived: 0,
      });
      expect(await task(id)).toEqual(before);
    }
    expect(h.adds).toEqual([]);
  });

  it('the global-pause lift holds a non-module fix-target task and lists it, and leaves a supported pin alone', async () => {
    const supported = SHAPES.findIndex((s) => s.name === 'supported guarded pin');
    const fixTarget = SHAPES.findIndex((s) => s.name === 'non-module fix target on the run list');
    const keep = await make(supported, { status: 'queued' });
    const [held] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId,
        type: slugOf(fixTarget),
        title: 'guard gates fix target',
        metadata: { anchorRepositoryId: null },
        status: 'queued',
        runListSnapshot: IDS,
        executionContract: SHAPES[fixTarget]!.contract,
        dataEdgePlan: null,
      })
      .returning({ id: schema.tasks.id });
    h.pauseOn = true;
    try {
      const res = await app.request('/admin/config/global-pause', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paused: false }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
      const body = (await res.json()) as { skippedTasks?: { taskId: string; code: string }[] };
      expect(body.skippedTasks).toEqual([
        { taskId: held!.id, code: REFUSAL_CODE, reason: expect.any(String) },
      ]);
    } finally {
      h.pauseOn = false;
    }
    expect((await task(held!.id)).pausedAt).toBeInstanceOf(Date);
    expect((await task(keep)).pausedAt).toBeNull();
  });
});
