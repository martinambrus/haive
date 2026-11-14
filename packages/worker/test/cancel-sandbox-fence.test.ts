import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
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
  FIX_TEST_RECORD_LIMIT,
  FIX_TEST_PENDING_COUNT,
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
    await db
      .update(schema.tasks)
      .set({ worktreePath: workspace })
      .where(eq(schema.tasks.id, task!.id));
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

  it('indexes only live contents and serves expiry and admission scans', async () => {
    const [index] = await db.$client<{ predicate: string }[]>`
      select pg_get_expr(indpred, indrelid) as predicate from pg_index
      where indexrelid = 'fix_test_blobs_expiry_idx'::regclass
    `;
    expect(index!.predicate).toContain('(expired_at IS NULL)');
    expect(index!.predicate).toContain('(content IS NOT NULL)');
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      for (const query of [
        sql`explain select task_id, content_hash from fix_test_blobs
          where expired_at is null and content is not null
          and created_at < now() - interval '30 days'
          order by created_at, task_id, content_hash limit 100`,
        sql`explain select task_id, content_hash, size_bytes from fix_test_blobs
          where expired_at is null and content is not null and size_bytes > 0
          order by created_at, task_id, content_hash`,
      ]) {
        expect(JSON.stringify(await tx.execute(query))).toContain('fix_test_blobs_expiry_idx');
      }
    });
  });

  it('replays both boundaries once, keeps the first reference through resets and a later pass', async () => {
    const meta = await seed();
    await writeFile(join(meta.workspace, 'tests/unchanged.test.ts'), 'unchanged');
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
    const payload = JSON.stringify(saved!.payload);
    expect(payload).not.toContain('base64');
    expect(payload).not.toContain('manifest\":');
    expect(Buffer.byteLength(payload)).toBeLessThan(600);
    expect(saved!.payload!.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload).not.toContain(meta.workspace);
    expect(payload).not.toContain('"image":');
    const blobs = await db
      .select()
      .from(schema.fixTestBlobs)
      .where(
        and(eq(schema.fixTestBlobs.taskId, meta.taskId), isNull(schema.fixTestBlobs.manifestGzip)),
      );
    expect(blobs).toHaveLength(2);
    expect(blobs.map((b) => b.content?.toString()).sort()).toEqual(['after one', 'before']);
    const [next] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: meta.taskId, taskStepId: meta.taskStepId, mode: 'cli', prompt: 'next' })
      .returning();
    await beginFixTestCapture(db, { ...meta, invocationId: next!.id, pass: 2 });
    const boundaries = await db.query.taskEvents.findMany({
      where: eq(schema.taskEvents.taskId, meta.taskId),
    });
    expect(boundaries.find((e) => e.eventType === FIX_TEST_AFTER)!.payload!.manifestHash).toBe(
      boundaries.find((e) => e.payload!.invocationId === next!.id)!.payload!.manifestHash,
    );
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
      await db
        .select()
        .from(schema.fixTestBlobs)
        .where(
          and(
            eq(schema.fixTestBlobs.taskId, meta.taskId),
            isNull(schema.fixTestBlobs.manifestGzip),
          ),
        ),
    ).toHaveLength(3);
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
    await beginFixTestCapture(db, meta);
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'changed');
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId, { taskBytes: 1 });
    expect((await loadFixTestRecords(db, meta.taskId))[0]!.changes[0]!.patch).toContain(
      'content not retained',
    );
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
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'after');
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    const first = (await loadFixTestRecords(db, meta.taskId))[0]!;
    const before = await db.query.taskEvents.findFirst({
      where: eq(schema.taskEvents.id, first.beforeEventId),
    });
    await db
      .update(schema.fixTestBlobs)
      .set({ createdAt: new Date(0) })
      .where(
        and(eq(schema.fixTestBlobs.taskId, meta.taskId), isNull(schema.fixTestBlobs.manifestGzip)),
      );
    await expireFixTestImages(db);
    const expired = await db.query.taskEvents.findFirst({
      where: eq(schema.taskEvents.id, first.beforeEventId),
    });
    expect(expired!.payload).toEqual(before!.payload);
    expect(expired!.payload!.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    const blobs = await db
      .select()
      .from(schema.fixTestBlobs)
      .where(
        and(eq(schema.fixTestBlobs.taskId, meta.taskId), isNull(schema.fixTestBlobs.manifestGzip)),
      );
    expect(blobs).toHaveLength(2);
    expect(blobs.every((b) => b.content === null && b.expiredAt instanceof Date)).toBe(true);
    expect((await loadFixTestRecords(db, meta.taskId))[0]!.changes[0]!.patch).toContain(
      'content not retained',
    );
    expect(
      (await db.query.taskEvents.findMany({ where: eq(schema.taskEvents.taskId, meta.taskId) }))
        .map((e) => e.eventType)
        .sort(),
    ).toEqual([FIX_TEST_AFTER, FIX_TEST_BEFORE].sort());
  });

  it('re-stores expired changed content when a later pass has those bytes again', async () => {
    const meta = await seed();
    await beginFixTestCapture(db, meta);
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'after');
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    const hash = (await loadFixTestRecords(db, meta.taskId))[0]!.changes[0]!.beforeHash!;
    await db
      .update(schema.fixTestBlobs)
      .set({ content: null, expiredAt: new Date() })
      .where(
        and(eq(schema.fixTestBlobs.taskId, meta.taskId), eq(schema.fixTestBlobs.contentHash, hash)),
      );
    const [next] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: meta.taskId, taskStepId: meta.taskStepId, mode: 'cli', prompt: 'next' })
      .returning();
    await beginFixTestCapture(db, { ...meta, invocationId: next!.id, pass: 2 });
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'before');
    await end(next!.id);
    await finishFixTestCapture(db, next!.id);
    const restored = await db.query.fixTestBlobs.findFirst({
      where: and(
        eq(schema.fixTestBlobs.taskId, meta.taskId),
        eq(schema.fixTestBlobs.contentHash, hash),
      ),
    });
    expect(restored!.expiredAt).toBeNull();
    expect(restored!.content!.toString()).toBe('before');
    expect((await loadFixTestRecords(db, meta.taskId))[1]!.changes[0]!.patch).toContain('+before');
  });

  it('records a refused begin explicitly when it no longer owns the step', async () => {
    const meta = await seed();
    await db
      .update(schema.taskSteps)
      .set({ status: 'pending' })
      .where(eq(schema.taskSteps.id, meta.taskStepId));
    await beginFixTestCapture(db, meta);
    expect((await loadFixTestRecords(db, meta.taskId))[0]).toMatchObject({ state: 'not captured' });
  });

  it('discloses lost provisional before bytes after cache eviction without losing the manifest', async () => {
    expect(FIX_TEST_PENDING_COUNT).toBe(128);
    const first = await seed();
    await beginFixTestCapture(db, first, { pendingCount: 1 });
    const second = await seed();
    await beginFixTestCapture(db, second, { pendingCount: 1 });
    await writeFile(join(first.workspace, 'tests/a.test.ts'), 'after eviction');
    await end(first.invocationId);
    await finishFixTestCapture(db, first.invocationId);
    const record = (await loadFixTestRecords(db, first.taskId))[0]!;
    expect(record.state).toBe('captured');
    expect(record.changes[0]!.beforeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.changes[0]!.patch).toContain('content not retained');
  });

  it('withholds a deleted before file when the repository policy starts denying it', async () => {
    const meta = await seed();
    const secretContent = randomBytes(18).toString('hex');
    await writeFile(join(meta.workspace, 'tests/.env.test'), secretContent);
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'evidence policy',
        source: 'blank',
        secretMaskAllow: ['**/.env.test'],
      })
      .returning();
    await db
      .update(schema.tasks)
      .set({ repositoryId: repo!.id })
      .where(eq(schema.tasks.id, meta.taskId));
    await beginFixTestCapture(db, meta);
    await rm(join(meta.workspace, 'tests/.env.test'));
    await db
      .update(schema.repositories)
      .set({ secretMaskAllow: [] })
      .where(eq(schema.repositories.id, repo!.id));
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    const blobs = await db
      .select()
      .from(schema.fixTestBlobs)
      .where(
        and(eq(schema.fixTestBlobs.taskId, meta.taskId), isNull(schema.fixTestBlobs.manifestGzip)),
      );
    expect(blobs).toHaveLength(0);
    expect((await loadFixTestRecords(db, meta.taskId))[0]!.changes[0]!.patch).toContain(
      'content withheld',
    );
  });

  it('keeps unchanged passes manifest-only and bounds records before gate persistence', async () => {
    expect(FIX_TEST_RECORD_LIMIT).toBe(30);
    const meta = await seed();
    await beginFixTestCapture(db, meta);
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    expect(
      await db
        .select()
        .from(schema.fixTestBlobs)
        .where(
          and(
            eq(schema.fixTestBlobs.taskId, meta.taskId),
            isNull(schema.fixTestBlobs.manifestGzip),
          ),
        ),
    ).toHaveLength(0);
    const records = await loadFixTestRecords(db, meta.taskId);
    expect(records[0]).toMatchObject({ state: 'captured', changes: [] });
    const saved = await db.query.taskEvents.findFirst({
      where: eq(schema.taskEvents.id, records[0]!.beforeEventId),
    });
    await db.insert(schema.taskEvents).values(
      [1, 2].map((n) => ({
        taskId: meta.taskId,
        taskStepId: meta.taskStepId,
        eventType: FIX_TEST_BEFORE,
        payload: { ...saved!.payload, invocationId: randomUUID(), pass: n + 1 },
        createdAt: new Date(Date.now() + n * 1000),
      })),
    );
    const limited = await loadFixTestRecords(db, meta.taskId, 2);
    expect(limited.map((r) => r.pass)).toEqual([2, 3]);
  });

  it('admits later tasks by evicting old bytes while preserving their hashes and events', async () => {
    const first = await seed();
    await beginFixTestCapture(db, first);
    await writeFile(join(first.workspace, 'tests/a.test.ts'), 'first');
    await end(first.invocationId);
    await finishFixTestCapture(db, first.invocationId, { storeBytes: 12 });
    const second = await seed();
    await beginFixTestCapture(db, second);
    await writeFile(join(second.workspace, 'tests/a.test.ts'), 'later');
    await end(second.invocationId);
    await finishFixTestCapture(db, second.invocationId, { storeBytes: 12 });
    expect((await loadFixTestRecords(db, second.taskId))[0]!.changes[0]!.patch).toContain('+later');
    expect((await loadFixTestRecords(db, first.taskId))[0]!.changes[0]!.patch).toContain(
      'content not retained',
    );
    const live = await db.select().from(schema.fixTestBlobs);
    expect(live.filter((b) => b.content).reduce((n, b) => n + b.sizeBytes, 0)).toBeLessThanOrEqual(
      12,
    );
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
