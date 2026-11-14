import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { createUnlessSuperseded, supersedeTaskRuns } from '../src/sandbox/cli-sandbox-fence.js';
import {
  beginFixTestCapture,
  finishFixTestCapture,
  loadFixTestRecords,
  expireFixTestImages,
  FIX_TEST_BEFORE,
  FIX_TEST_AFTER,
  FIX_TEST_TASK_BYTES,
  FIX_TEST_STORE_BYTES,
  FIX_TEST_RETENTION_DAYS,
} from '../src/step-engine/steps/workflow/_fix-test-store.js';
import { captureTestImage } from '../src/step-engine/steps/workflow/_fix-test-edits.js';

const url = process.env.CANCEL_FENCE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/cancel_fence_test'))
  throw new Error('Use a dedicated cancel_fence_test database for the cancel fence tests');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)('repair evidence shares the invocation ownership fence, on Postgres', () => {
  let db: Database;
  let userId: string;
  const dirs: string[] = [];
  beforeAll(async () => {
    db = createDatabase(url!);
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: randomBytes(16).toString('hex'),
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });
  const seed = async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fix-evidence-'));
    dirs.push(workspace);
    await mkdir(join(workspace, 'tests'));
    await writeFile(join(workspace, 'tests/a.test.ts'), 'before');
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'workflow', title: 'fix evidence', status: 'running' })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '08b-test-management',
        stepIndex: 1,
        title: 'repair',
        round: 2,
        status: 'waiting_cli',
      })
      .returning();
    const [run] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: task!.id, taskStepId: step!.id, mode: 'cli', prompt: 'repair' })
      .returning();
    return {
      taskId: task!.id,
      taskStepId: step!.id,
      invocationId: run!.id,
      stepId: step!.stepId,
      round: 2,
      pass: 1,
      epoch: 0,
      workspace,
    };
  };
  const end = async (id: string) => {
    await db
      .update(schema.cliInvocations)
      .set({ endedAt: new Date(), exitCode: 0 })
      .where(eq(schema.cliInvocations.id, id));
  };

  it('replays both boundaries once, keeps the first reference through resets and a later pass', async () => {
    const meta = await seed();
    await Promise.all([beginFixTestCapture(db, meta), beginFixTestCapture(db, meta)]);
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'after one');
    await end(meta.invocationId);
    await Promise.all([
      finishFixTestCapture(db, meta.invocationId),
      finishFixTestCapture(db, meta.invocationId),
    ]);
    const first = (await loadFixTestRecords(db, meta.taskId))[0]!;
    expect(first).toMatchObject({
      pass: 1,
      round: 2,
      state: 'captured',
      changes: [{ path: 'tests/a.test.ts' }],
    });
    const saved = await db.query.taskEvents.findFirst({
      where: eq(schema.taskEvents.id, first.beforeEventId),
    });
    const [next] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: meta.taskId, taskStepId: meta.taskStepId, mode: 'cli', prompt: 'next' })
      .returning();
    await beginFixTestCapture(db, { ...meta, invocationId: next!.id, pass: 2 });
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'after two');
    await end(next!.id);
    await finishFixTestCapture(db, next!.id);
    await db
      .update(schema.taskSteps)
      .set({ output: null, status: 'pending' })
      .where(eq(schema.taskSteps.id, meta.taskStepId));
    const records = await loadFixTestRecords(db, meta.taskId);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(first);
    expect(records[1]!.changes[0]!.beforeHash).toBe(first.changes[0]!.afterHash);
    expect(
      (await db.query.taskEvents.findFirst({
        where: eq(schema.taskEvents.id, first.beforeEventId),
      }))!.payload,
    ).toEqual(saved!.payload);
  });

  it('does not publish a complete after-image when cancellation wins during capture', async () => {
    const meta = await seed();
    await beginFixTestCapture(db, meta);
    await end(meta.invocationId);
    let reached!: () => void;
    let release!: () => void;
    const read = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishing = finishFixTestCapture(db, meta.invocationId, {
      capture: async (a, p) => {
        const image = await captureTestImage(a, p);
        reached();
        await proceed;
        return image;
      },
    });
    await read;
    await db.transaction(async (tx) => {
      await tx
        .update(schema.cliInvocations)
        .set({ supersededAt: new Date() })
        .where(eq(schema.cliInvocations.id, meta.invocationId));
      await tx
        .update(schema.taskSteps)
        .set({ status: 'failed' })
        .where(eq(schema.taskSteps.id, meta.taskStepId));
      await tx
        .update(schema.tasks)
        .set({ status: 'cancelled', orchestrationEpoch: 1 })
        .where(eq(schema.tasks.id, meta.taskId));
    });
    release();
    await finishing;
    expect((await loadFixTestRecords(db, meta.taskId))[0]!.state).toBe('not captured');
    const events = await db.query.taskEvents.findMany({
      where: eq(schema.taskEvents.taskId, meta.taskId),
    });
    expect(events.map((e) => e.eventType)).toEqual([FIX_TEST_BEFORE]);
  });

  it('marks a storage refusal and an interrupted invocation as not captured', async () => {
    expect([FIX_TEST_TASK_BYTES, FIX_TEST_STORE_BYTES, FIX_TEST_RETENTION_DAYS]).toEqual([
      16777216, 67108864, 30,
    ]);
    const meta = await seed();
    await beginFixTestCapture(db, meta, { taskBytes: 1 });
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    expect((await loadFixTestRecords(db, meta.taskId))[0]!.state).toBe('not captured');
    const other = await seed();
    await beginFixTestCapture(db, other);
    await db
      .update(schema.cliInvocations)
      .set({ endedAt: new Date(), exitCode: 137 })
      .where(eq(schema.cliInvocations.id, other.invocationId));
    await finishFixTestCapture(db, other.invocationId);
    expect((await loadFixTestRecords(db, other.taskId))[0]!.state).toBe('not captured');
  });

  it('expires whole content while retaining the pinned reference and disclosing its absence', async () => {
    const meta = await seed();
    await beginFixTestCapture(db, meta);
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    const first = (await loadFixTestRecords(db, meta.taskId))[0]!;
    const before = await db.query.taskEvents.findFirst({
      where: eq(schema.taskEvents.id, first.beforeEventId),
    });
    await db
      .update(schema.taskEvents)
      .set({ createdAt: new Date(0) })
      .where(eq(schema.taskEvents.taskId, meta.taskId));
    await expireFixTestImages(db);
    const expired = await db.query.taskEvents.findFirst({
      where: eq(schema.taskEvents.id, first.beforeEventId),
    });
    expect(expired!.payload!.image).toBeUndefined();
    expect(expired!.payload!.imageHash).toBe(before!.payload!.imageHash);
    expect((await loadFixTestRecords(db, meta.taskId))[0]!.state).toBe('not captured');
    expect(
      (await db.query.taskEvents.findMany({ where: eq(schema.taskEvents.taskId, meta.taskId) }))
        .map((e) => e.eventType)
        .sort(),
    ).toEqual([FIX_TEST_AFTER, FIX_TEST_BEFORE].sort());
  });
});

describe.skipIf(!url)('the cancel and a CLI run share one sandbox fence', () => {
  let db: Database;
  let userId: string;
  let repoId: string;

  beforeAll(async () => {
    db = createDatabase(url!);
    userId = randomUUID();
    repoId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: randomBytes(16).toString('hex'),
    });
    await db.insert(schema.repositories).values({
      id: repoId,
      userId,
      name: 'cancel-fence-test',
      source: 'blank',
      storagePath: `/tmp/cancel-fence-test/${userId}/${repoId}`,
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });

  async function run(): Promise<{ taskId: string; invocationId: string }> {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repoId,
        title: 'cancel fence',
        type: 'workflow',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    const [inv] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: task!.id, mode: 'cli', prompt: 'p' })
      .returning({ id: schema.cliInvocations.id });
    return { taskId: task!.id, invocationId: inv!.id };
  }
  async function supersededAt(invocationId: string): Promise<Date | null> {
    const [row] = await db
      .select({ at: schema.cliInvocations.supersededAt })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.id, invocationId));
    return row!.at;
  }

  it('holds the cancel supersede back while a run that passed its check is creating', async () => {
    const ids = await run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let creating!: () => void;
    const inCreate = new Promise<void>((resolve) => (creating = resolve));
    const create = vi.fn(async () => {
      creating();
      await gate;
      return 'container';
    });

    const creation = createUnlessSuperseded(db, ids, create);
    await inCreate;
    let cancelled = false;
    const cancel = supersedeTaskRuns(db, ids.taskId).then(() => {
      cancelled = true;
    });
    await sleep(600);
    expect(cancelled).toBe(false);
    expect(await supersededAt(ids.invocationId)).toBeNull();

    release();
    await expect(creation).resolves.toBe('container');
    await cancel;
    expect(create).toHaveBeenCalledTimes(1);
    expect(await supersededAt(ids.invocationId)).not.toBeNull();
  });

  it('creates nothing when the cancel superseded the run first', async () => {
    const ids = await run();
    await supersedeTaskRuns(db, ids.taskId);
    const create = vi.fn(async () => 'container');
    await expect(createUnlessSuperseded(db, ids, create)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('creates nothing for a run that already ended', async () => {
    const ids = await run();
    await db
      .update(schema.cliInvocations)
      .set({ endedAt: new Date() })
      .where(eq(schema.cliInvocations.id, ids.invocationId));
    const create = vi.fn(async () => 'container');
    await expect(createUnlessSuperseded(db, ids, create)).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not make another task wait', async () => {
    const a = await run();
    const b = await run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let creating!: () => void;
    const inCreate = new Promise<void>((resolve) => (creating = resolve));
    const creation = createUnlessSuperseded(db, a, async () => {
      creating();
      await gate;
      return 'container';
    });
    await inCreate;
    await supersedeTaskRuns(db, b.taskId);
    expect(await supersededAt(b.invocationId)).not.toBeNull();
    release();
    await creation;
  });
});
