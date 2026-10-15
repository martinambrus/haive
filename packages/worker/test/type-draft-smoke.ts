/** A `type_draft` conversation through the real task queue, database and Redis, with a stub agent per scenario. */
import { SMOKE_STORAGE_ROOT } from './_smoke-storage-root.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { Queue } from 'bullmq';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  configService,
  logger,
  secretsService,
  userSecretsService,
  type TaskJobPayload,
} from '@haive/shared';
import { TYPE_DRAFT_MESSAGE_EVENT } from '@haive/shared/modularity';
import { initDatabase } from '../src/db.js';
import { closeRedis, getBullRedis, initRedis } from '../src/redis.js';
import {
  closeTaskQueue,
  setContainerCleanupRunner,
  startTaskWorker,
} from '../src/queues/task-queue.js';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import { syncTaskTypeDefinitions } from '../src/step-engine/task-type-seed.js';
import { UNTRUSTED_OPEN } from '../src/step-engine/steps/_untrusted-repo.js';
import {
  TYPE_DRAFT_REPAIR_EVENT,
  type TypeDraftDetect,
} from '../src/step-engine/steps/type-draft/_type-draft.js';

process.env.HAIVE_TEST_BYPASS_LLM = '1';

const log = logger.child({ module: 'type-draft-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const STEP_ID = '01-type-draft';
const WAIT_MS = 90_000;

const promptStep = (over: Record<string, unknown> = {}) => ({
  slug: 'list-todos',
  title: 'List TODO comments',
  template: 'List every TODO comment in the repository for {{task.title}}.',
  capabilities: ['tool_use'],
  timeoutMs: 600_000,
  ...over,
});
const FIRST_ID = 'custom.todo-audit.list-todos';
const SECOND_ID = 'custom.todo-audit.rate-todos';
const draftOne = () => ({
  slug: 'todo-audit',
  displayName: 'TODO audit',
  requiresRepository: true,
  stepIds: [FIRST_ID],
  promptSteps: { 'list-todos': promptStep() },
});
const draftTwo = () => ({
  ...draftOne(),
  stepIds: [FIRST_ID, SECOND_ID],
  promptSteps: {
    'list-todos': promptStep(),
    'rate-todos': promptStep({
      slug: 'rate-todos',
      title: 'Rate TODO comments',
      template: `Rate how urgent each of these is.\n\n{{step:${FIRST_ID}}}\n`,
      capabilities: [],
    }),
  },
});
const draftInvalid = () => ({ ...draftOne(), stepIds: [FIRST_ID, 'no-such-step'] });
const withTool = { name: 'repo_status', description: 'Fetches the status.', action: 'x' };

interface Call {
  key: string;
  n: number;
  repair: boolean;
  fromEditor: boolean;
  editorDraft: unknown;
  prompt: string;
}
const calls: Call[] = [];
type Scenario = (call: Call) => unknown;
const scenarios: Record<string, Scenario> = {
  S1: (call) =>
    call.n === 1
      ? { reply: 'Draft one.', draft: draftOne() }
      : { reply: 'Draft two.', draft: draftTwo() },
  S2a: (call) =>
    call.repair
      ? { reply: 'Corrected.', draft: draftOne() }
      : { reply: 'First try.', draft: draftInvalid() },
  S2b: (call) =>
    call.n >= 3
      ? { reply: 'Corrected at last.', draft: draftOne() }
      : { reply: `Try ${call.n}.`, draft: draftInvalid() },
  S3: () => ({
    reply: 'With a tool.',
    draft: { ...draftOne(), promptSteps: { 'list-todos': promptStep({ tools: [withTool] }) } },
  }),
  S4: () => 'Sorry, I cannot produce JSON today.',
};

async function main(): Promise<void> {
  initRedis(process.env.REDIS_URL!);
  await configService.initialize(process.env.REDIS_URL!);
  const db = initDatabase(process.env.DATABASE_URL!);
  await secretsService.initialize(db);
  await userSecretsService.initialize(db, await secretsService.getMasterKek());
  setContainerCleanupRunner(async () => 0);

  const userId = randomUUID();
  const existingSlug = `td-smoke-${randomBytes(3).toString('hex')}`;
  let worker: ReturnType<typeof startTaskWorker> | null = null;
  let queue: Queue<TaskJobPayload> | null = null;

  const definitionsFingerprint = async () => {
    const rows = (await db.execute(sql`
      select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by slug), '')) as md5,
             count(*)::int as n
      from task_type_definitions t`)) as unknown as Array<{ md5: string; n: number }>;
    return rows[0]!;
  };
  const view = async (taskId: string) => {
    const [t] = await db
      .select({
        status: schema.tasks.status,
        errorMessage: schema.tasks.errorMessage,
        repositoryId: schema.tasks.repositoryId,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId));
    return t!;
  };
  const events = async (taskId: string) =>
    db
      .select({ type: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, taskId))
      .orderBy(asc(schema.taskEvents.createdAt));
  const messages = async (taskId: string) =>
    (await events(taskId))
      .filter((e) => e.type === TYPE_DRAFT_MESSAGE_EVENT)
      .map((e) => e.payload as Record<string, unknown>);
  const until = async <T>(label: string, read: () => Promise<T | null>): Promise<T> => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  const parkedStep = async (taskId: string, assistantTurns: number) => {
    const t = await view(taskId);
    if (t.status === 'failed') throw new Error(`task failed: ${t.errorMessage ?? 'unknown'}`);
    if (t.status !== 'waiting_user') return null;
    if ((await messages(taskId)).filter((m) => m.role === 'assistant').length !== assistantTurns) {
      return null;
    }
    const [step] = await db
      .select({ id: schema.taskSteps.id, round: schema.taskSteps.round })
      .from(schema.taskSteps)
      .where(
        and(
          eq(schema.taskSteps.taskId, taskId),
          eq(schema.taskSteps.stepId, STEP_ID),
          eq(schema.taskSteps.status, 'waiting_form'),
          sql`${schema.taskSteps.waitingStartedAt} is not null`,
        ),
      );
    return step ?? null;
  };
  const submit = async (
    taskId: string,
    step: { id: string; round: number },
    values: Record<string, unknown>,
  ) => {
    await db
      .update(schema.taskSteps)
      .set({ formValues: values, waitingStartedAt: null, updatedAt: new Date() })
      .where(eq(schema.taskSteps.id, step.id));
    await queue!.add(TASK_JOB_NAMES.ADVANCE_STEP, {
      taskId,
      userId,
      stepId: STEP_ID,
      round: step.round,
      formValues: values,
    });
  };

  /** What the create route does: the task row, then the opening turn, then the job. */
  const open = async (
    definitionSteps: string[],
    opening: string,
    editorState?: Record<string, unknown>,
  ) => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'type_draft',
        title: 'Draft a task type',
        repositoryId: null,
        autoContinue: true,
        metadata: { anchorRepositoryId: null, egress: { mode: 'none', domains: [], ips: [] } },
        runListSnapshot: definitionSteps,
        status: 'created',
      })
      .returning({ id: schema.tasks.id });
    await db.insert(schema.taskEvents).values({
      taskId: task!.id,
      eventType: TYPE_DRAFT_MESSAGE_EVENT,
      payload: { role: 'user', body: opening, ...(editorState ? { draft: editorState } : {}) },
    });
    await queue!.add(TASK_JOB_NAMES.START, { taskId: task!.id, userId });
    return task!.id;
  };
  const finish = async (taskId: string, assistantTurns: number) => {
    const step = await until('the last form', () => parkedStep(taskId, assistantTurns));
    await submit(taskId, step, { message: '' });
    return until('the task to end', async () => {
      const t = await view(taskId);
      if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return t;
      return null;
    });
  };
  const callsFor = (key: string) => calls.filter((c) => c.key === key);

  try {
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'type-draft-smoke@test.local',
      emailBlindIndex: `type-draft-smoke-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'admin',
      status: 'active',
      tokenVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    registerStepsOnce();
    await syncStepCatalog(db, stepRegistry);
    await syncTaskTypeDefinitions(db, stepRegistry, []);
    await db.insert(schema.taskTypeDefinitions).values({
      slug: existingSlug,
      displayName: 'Existing admin type',
      runListStrategy: 'static',
      stepIds: ['00-triage'],
      source: 'admin',
    });

    const [seeded] = await db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, 'type_draft'));
    check(
      'the boot seed stores type_draft as a hidden built-in with the one step and no repository',
      seeded !== undefined &&
        seeded.source === 'builtin' &&
        seeded.runListStrategy === 'static' &&
        same(seeded.stepIds, [STEP_ID]) &&
        seeded.selectable === false &&
        seeded.requiresRepository === false,
      seeded,
    );
    // Loaded at run time: the worker's typecheck must not pull api source into its program.
    const apiDefinitions = (await import(
      new URL('../../api/src/lib/task-type-definition.ts', import.meta.url).href
    )) as {
      definitionForCreate: (
        handle: unknown,
        slug: string,
        opts: { generic: boolean },
      ) => Promise<{
        runListSnapshot: string[] | null;
        customSteps: unknown;
        requiresRepository: boolean;
        repoOptional: boolean;
      }>;
    };
    const created = await apiDefinitions.definitionForCreate(db, 'type_draft', { generic: false });
    const refused = await apiDefinitions
      .definitionForCreate(db, 'type_draft', { generic: true })
      .then(() => null)
      .catch((err: unknown) => err as { status?: number });
    check(
      'the create path of a route for this type snapshots the one step with no repository, and the generic form refuses it',
      same(created.runListSnapshot, [STEP_ID]) &&
        created.customSteps === null &&
        created.requiresRepository === false &&
        created.repoOptional === true &&
        refused?.status === 403,
      { created, refused },
    );
    const snapshot = created.runListSnapshot ?? [STEP_ID];
    const before = await definitionsFingerprint();

    const stub = stepRegistry.get(STEP_ID)!.llm!;
    stub.bypassStub = (args) => {
      const d = args.detected as TypeDraftDetect;
      const key = (d.pendingQuestion ?? '').split(':')[0]!;
      const call: Call = {
        key,
        n: callsFor(key).length + 1,
        repair: d.repairPending !== null,
        fromEditor: d.currentDraft?.from === 'editor',
        editorDraft: d.currentDraft?.draft ?? null,
        prompt: stub.buildPrompt(args),
      };
      calls.push(call);
      return scenarios[key]!(call);
    };

    worker = startTaskWorker();
    queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, { connection: getBullRedis() });

    // S1: two turns and a blank submit.
    const s1 = await open(snapshot, 'S1: a read-only TODO audit', {
      ...draftOne(),
      displayName: 'Seeded by hand',
      enabled: true,
      promptSteps: { 'list-todos': promptStep({ tools: [withTool], agentPool: '*' }) },
    });
    const s1Step = await until('the first reply', () => parkedStep(s1, 1));
    await submit(s1, s1Step, {
      message: 'S1: now rate each one',
      draft: JSON.stringify({
        ...draftOne(),
        displayName: 'Edited by hand',
        enabled: true,
        promptSteps: { 'list-todos': promptStep({ tools: [withTool], agentPool: '*' }) },
      }),
    });
    const s1End = await finish(s1, 2);
    const s1Messages = await messages(s1);
    check(
      'S1 two turns and a blank submit end the task completed, neither failed nor on a repository',
      s1End.status === 'completed' && s1End.errorMessage === null && s1End.repositoryId === null,
      s1End,
    );
    check(
      'S1 the transcript holds four turns in order, and no repair record',
      s1Messages.map((m) => m.role).join() === 'user,assistant,user,assistant' &&
        (await events(s1)).every((e) => e.type !== TYPE_DRAFT_REPAIR_EVENT),
      s1Messages.map((m) => m.role),
    );
    check(
      'S1 each reply carries its draft with no issue, and the agent was called once per turn',
      same(s1Messages[1]?.draft, draftOne()) &&
        same(s1Messages[3]?.draft, draftTwo()) &&
        same(s1Messages[1]?.issues, []) &&
        same(s1Messages[3]?.issues, []) &&
        callsFor('S1').length === 2 &&
        callsFor('S1').every((c) => !c.repair),
      { messages: s1Messages, calls: callsFor('S1') },
    );
    const editorKept = { ...draftOne(), displayName: 'Edited by hand' };
    check(
      'S1 the editor state was stored without what the editor cannot show, and the second call read it',
      same(s1Messages[2]?.draft, editorKept) &&
        callsFor('S1')[1]?.fromEditor === true &&
        same(callsFor('S1')[1]?.editorDraft, editorKept) &&
        callsFor('S1')[0]?.fromEditor === true &&
        same(callsFor('S1')[0]?.editorDraft, { ...draftOne(), displayName: 'Seeded by hand' }),
      { stored: s1Messages[2]?.draft, calls: callsFor('S1') },
    );

    const s1Prompts = callsFor('S1').map((c) => c.prompt);
    check(
      'S1 the prompt built from the stored detect output carries the editor state, fenced, and no tool',
      s1Prompts.length === 2 &&
        s1Prompts[0]!.includes('Seeded by hand') &&
        !s1Prompts[0]!.includes('repo_status') &&
        !s1Prompts[0]!.includes('Edited by hand') &&
        s1Prompts[1]!.includes(`${UNTRUSTED_OPEN}\n{`) &&
        s1Prompts[1]!.includes('Edited by hand') &&
        !s1Prompts[1]!.includes('repo_status') &&
        s1Prompts[1]!.includes('S1: now rate each one'),
      s1Prompts.map((p) => p.length),
    );

    // S2a: the repair fixes the draft.
    const s2a = await open(snapshot, 'S2a: an invalid draft that one repair fixes');
    const s2aEnd = await finish(s2a, 1);
    const s2aMessages = await messages(s2a);
    const s2aRepairs = (await events(s2a)).filter((e) => e.type === TYPE_DRAFT_REPAIR_EVENT);
    check(
      'S2a an invalid first draft costs exactly one repair dispatch, and the turn shows the repaired draft',
      s2aEnd.status === 'completed' &&
        callsFor('S2a').length === 2 &&
        callsFor('S2a').filter((c) => c.repair).length === 1 &&
        s2aRepairs.length === 1 &&
        s2aMessages.length === 2 &&
        s2aMessages[1]?.repaired === true &&
        s2aMessages[1]?.body === 'Corrected.' &&
        same(s2aMessages[1]?.issues, []),
      { calls: callsFor('S2a'), repairs: s2aRepairs.length, messages: s2aMessages },
    );

    check(
      'S2a only the repair prompt carries the failed draft and what Haive found wrong with it',
      callsFor('S2a')[0]?.prompt.includes('FAILED') === false &&
        callsFor('S2a')[1]?.prompt.includes('FAILED') === true &&
        callsFor('S2a')[1]?.prompt.includes('no-such-step') === true,
      callsFor('S2a').map((c) => c.prompt.length),
    );

    // S2b: the repair does not fix it; still one dispatch, issues shown.
    const s2b = await open(snapshot, 'S2b: an invalid draft that the repair does not fix');
    const s2bEnd = await finish(s2b, 1);
    const s2bMessages = await messages(s2b);
    check(
      'S2b a repair that fails is not repaired again: one repair dispatch, the issues stay on the turn',
      s2bEnd.status === 'completed' &&
        callsFor('S2b').length === 2 &&
        callsFor('S2b').filter((c) => c.repair).length === 1 &&
        s2bMessages[1]?.repaired === true &&
        Array.isArray(s2bMessages[1]?.issues) &&
        (s2bMessages[1]?.issues as unknown[]).length > 0,
      { calls: callsFor('S2b'), messages: s2bMessages },
    );

    // S3: a custom tool never reaches the recorded draft.
    const s3 = await open(snapshot, 'S3: a draft that carries a custom tool');
    const s3End = await finish(s3, 1);
    const s3Messages = await messages(s3);
    check(
      'S3 the recorded draft has no tools, and dropped names where they were, with no repair spent',
      s3End.status === 'completed' &&
        callsFor('S3').length === 1 &&
        same(s3Messages[1]?.draft, draftOne()) &&
        !JSON.stringify(s3Messages[1]).includes('repo_status') &&
        same(s3Messages[1]?.dropped, ['promptSteps.list-todos.tools']) &&
        same(s3Messages[1]?.issues, []),
      s3Messages[1],
    );

    // S4: a reply that is not JSON. The runner treats the bypass as the last attempt.
    const s4 = await open(snapshot, 'S4: a reply that is not JSON');
    const s4End = await finish(s4, 1);
    const s4Messages = await messages(s4);
    check(
      'S4 an unreadable reply on the last attempt is recorded as a turn with no draft, and spends no repair',
      s4End.status === 'completed' &&
        callsFor('S4').length === 1 &&
        s4Messages[1]?.draft === null &&
        typeof s4Messages[1]?.error === 'string' &&
        (await events(s4)).every((e) => e.type !== TYPE_DRAFT_REPAIR_EVENT),
      s4Messages[1],
    );

    const after = await definitionsFingerprint();
    const [named] = await db
      .select({ slug: schema.taskTypeDefinitions.slug })
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, 'todo-audit'));
    check(
      'no conversation wrote task_type_definitions: the table is byte-identical and the drafted slug is not in it',
      before.md5 === after.md5 && before.n === after.n && named === undefined,
      { before, after, named },
    );
  } finally {
    await worker?.close().catch(() => undefined);
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await db.delete(schema.tasks).where(eq(schema.tasks.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db
      .delete(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.slug, existingSlug));
    await rm(SMOKE_STORAGE_ROOT, { recursive: true, force: true });
    await closeTaskQueue();
    await closeRedis();
  }
}

main()
  .then(() => {
    log.info(
      { checks, failures },
      failures === 0 ? 'type draft smoke passed' : 'type draft smoke FAILED',
    );
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    log.error({ err }, 'type draft smoke crashed');
    process.exit(1);
  });
