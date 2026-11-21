import { loadUnactedInsights } from '../src/step-engine/steps/workflow/_insight-loader.js';
import * as stepCommands from '../src/sandbox/step-command.js';
import * as appRuntime from '../src/step-engine/steps/workflow/_app-runtime.js';
import { phase5VerifyStep } from '../src/step-engine/steps/workflow/08-phase-5-verify.js';
import { handleResult, closeTaskQueue } from '../src/queues/task-queue.js';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { persistInsightReport } from '../src/step-engine/steps/workflow/_insight-summary.js';
import {
  gate3InsightCycle,
  recordGate3Check,
  pendingInsightApproval,
} from '../src/queues/insight-gate3-return.js';
import {
  changeInsightPage,
  insightPageOffset,
} from '../src/step-engine/steps/workflow/_insight-page.js';
import { buildClassifierPrompt } from '../src/step-engine/steps/workflow/_insight-auto.js';
import { startAutoClassification } from '../src/step-engine/steps/workflow/_insight-auto-flow.js';
import {
  claimAutoRound,
  loadAutoHistory,
  saveAutoClassification,
} from '../src/step-engine/steps/workflow/_insight-auto.js';
import { hasCliWork } from '../src/queues/task-queue.js';
import { handoffInsightContinuation } from '../src/queues/insight-continuation.js';
import {
  activeInsightContinuation,
  publishInsightStep,
  continuationForOutcome,
} from '../src/step-engine/steps/workflow/_insight-continuation.js';
import * as specArtifacts from '../src/step-engine/steps/workflow/_spec-artifact.js';
import * as validationSnapshots from '../src/step-engine/steps/workflow/_validation-snapshot.js';
import { advanceStep, finishedStepResult } from '../src/step-engine/step-runner.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { lockOwnedStep } from '../src/step-engine/step-ownership.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import type { StepContext, StepDefinition } from '../src/step-engine/step-definition.js';
import {
  insightBatchId,
  ensureInsightIntent,
  appendInsightBatch,
  recordInsightInvocation,
  recordInsightReservation,
  loadInsightBatchRecords,
} from '../src/step-engine/steps/workflow/_insight-batch.js';
import { insightsTriageStep } from '../src/step-engine/steps/workflow/08e-insights-triage.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
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
import { gitExec } from '../src/repo/git-exec.js';
import { captureTestImage } from '../src/step-engine/steps/workflow/_fix-test-edits.js';

const testQueue = vi.hoisted(() => ({ jobs: [] as unknown[] }));
vi.mock('../src/redis.js', async (original) => ({
  ...(await original<object>()),
  getBullRedis: () => ({}),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<object>()),
  Queue: class {
    async add(_name: string, data: unknown) {
      testQueue.jobs.push(data);
      return { id: 'test' };
    }
    async close() {}
  },
}));

// Real checkpoint completion takes the mining barrier, whose browser cleanup must stay off Docker.
vi.mock('../src/sandbox/runner-browser-cdp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  closeExtraBrowserTabs: async () => null,
  restoreBrowserWindow: async () => null,
}));

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

  it.each(['tests/.env.test', '.env'])(
    'redacts a credential copied from %s at the blob write',
    async (source) => {
      const meta = await seed();
      const secret = randomBytes(24).toString('hex');
      const content = `ordinary before\r\nTOKEN="${secret}"\r\nordinary after\n`;
      await writeFile(join(meta.workspace, source), content);
      if (source.startsWith('tests/')) {
        await gitExec(['init', '-q'], { cwd: meta.workspace });
        await gitExec(['add', '--', source], { cwd: meta.workspace });
      }
      await beginFixTestCapture(db, meta);
      await copyFile(join(meta.workspace, source), join(meta.workspace, 'tests/copied.json'));
      await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'after copy\r\n');
      await end(meta.invocationId);
      await finishFixTestCapture(db, meta.invocationId);
      const blobs = await db
        .select()
        .from(schema.fixTestBlobs)
        .where(
          and(
            eq(schema.fixTestBlobs.taskId, meta.taskId),
            isNull(schema.fixTestBlobs.manifestGzip),
          ),
        );
      const contents = blobs.map((b) => b.content?.toString());
      expect(contents).toContain(
        'ordinary before\r\ncontent withheld by secret policy.\r\nordinary after\n',
      );
      expect(contents).toContain('after copy\r\n');
      expect(
        blobs.some((b) => b.contentHash === createHash('sha256').update(content).digest('hex')),
      ).toBe(true);
      expect(contents.join('')).not.toContain(secret);
      expect(JSON.stringify(await loadFixTestRecords(db, meta.taskId))).not.toContain(secret);
    },
  );

  it.each([
    ['NUL-containing', Buffer.from([0])],
    ['non-UTF-8', Buffer.from([0xff])],
  ] as const)(
    'withholds an entire %s repair blob while preserving its measured hash',
    async (_kind, binaryByte) => {
      const meta = await seed();
      await beginFixTestCapture(db, meta);
      const secret = randomBytes(24).toString('hex');
      const content = Buffer.concat([
        Buffer.from('before'),
        binaryByte,
        Buffer.from(`\nTOKEN="${secret}"\nafter`),
      ]);
      await writeFile(join(meta.workspace, 'tests/a.test.ts'), content);
      await end(meta.invocationId);
      await finishFixTestCapture(db, meta.invocationId);
      const hash = createHash('sha256').update(content).digest('hex');
      const blob = await db.query.fixTestBlobs.findFirst({
        where: and(
          eq(schema.fixTestBlobs.taskId, meta.taskId),
          eq(schema.fixTestBlobs.contentHash, hash),
        ),
      });
      expect(blob?.content?.toString()).toBe('content withheld by secret policy.');
      expect(blob?.content?.includes(Buffer.from(secret))).toBe(false);
      const records = await loadFixTestRecords(db, meta.taskId);
      expect(records[0]!.changes[0]!.afterHash).toBe(hash);
      expect(JSON.stringify(records)).not.toContain(secret);
      // Existing rows are rechecked at display too; do not wait for expiry to hide them.
      await db
        .update(schema.fixTestBlobs)
        .set({ content: Buffer.from(content) })
        .where(
          and(
            eq(schema.fixTestBlobs.taskId, meta.taskId),
            eq(schema.fixTestBlobs.contentHash, hash),
          ),
        );
      const legacy = JSON.stringify(await loadFixTestRecords(db, meta.taskId));
      expect(legacy).not.toContain(secret);
      expect(legacy).toContain('content withheld by secret policy.');
    },
  );

  it('keeps no content when a protected fixture moves to an allowed name', async () => {
    const meta = await seed();
    const secret = `TOKEN=${randomBytes(24).toString('hex')}`;
    await writeFile(join(meta.workspace, 'tests/.env.test'), secret);
    await beginFixTestCapture(db, meta);
    await rm(join(meta.workspace, 'tests/.env.test'));
    await writeFile(join(meta.workspace, 'tests/config.json'), secret);
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'after move');
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    const [record] = await loadFixTestRecords(db, meta.taskId, 30, { patches: true });
    expect(record!.changes.map((c) => c.path).sort()).toEqual([
      'tests/.env.test',
      'tests/a.test.ts',
      'tests/config.json',
    ]);
    expect(JSON.stringify(record)).not.toContain(secret);
    const blobs = await db
      .select()
      .from(schema.fixTestBlobs)
      .where(
        and(eq(schema.fixTestBlobs.taskId, meta.taskId), isNull(schema.fixTestBlobs.manifestGzip)),
      );
    expect(blobs).toHaveLength(0);
  });

  it('keeps no content in a later pass that edits a file a protected fixture moved to', async () => {
    const meta = await seed();
    const secret = `TOKEN=${randomBytes(24).toString('hex')}`;
    await writeFile(join(meta.workspace, 'tests/.env.test'), secret);
    await beginFixTestCapture(db, meta);
    await rm(join(meta.workspace, 'tests/.env.test'));
    await writeFile(join(meta.workspace, 'tests/config.json'), secret);
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId);
    const [next] = await db
      .insert(schema.cliInvocations)
      .values({ taskId: meta.taskId, taskStepId: meta.taskStepId, mode: 'cli', prompt: 'next' })
      .returning();
    await beginFixTestCapture(db, { ...meta, invocationId: next!.id, pass: 2 });
    await writeFile(join(meta.workspace, 'tests/config.json'), `${secret}\nEDITED=1`);
    await end(next!.id);
    await finishFixTestCapture(db, next!.id);
    const records = await loadFixTestRecords(db, meta.taskId, 30, { patches: true });
    expect(records).toHaveLength(2);
    expect(records[1]!.changes.map((c) => c.path)).toEqual(['tests/config.json']);
    expect(JSON.stringify(records)).not.toContain(secret);
    const blobs = await db
      .select()
      .from(schema.fixTestBlobs)
      .where(
        and(eq(schema.fixTestBlobs.taskId, meta.taskId), isNull(schema.fixTestBlobs.manifestGzip)),
      );
    expect(blobs).toHaveLength(0);
  });

  it('keeps an ended DAG sibling open for its normal finish without tainting later passes', async () => {
    const meta = await seed();
    await db
      .update(schema.cliInvocations)
      .set({ mode: 'dag_parallel' })
      .where(eq(schema.cliInvocations.id, meta.invocationId));
    await beginFixTestCapture(db, meta);
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'legitimate sibling edit');
    await end(meta.invocationId);
    const [next] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: meta.taskId,
        taskStepId: meta.taskStepId,
        mode: 'dag_parallel',
        prompt: 'sibling fix',
      })
      .returning();
    // resolveReviewPhase can begin issue X's next coder before ingesting ended issue Z.
    await beginFixTestCapture(db, { ...meta, invocationId: next!.id, pass: 2 });
    await loadFixTestRecords(db, meta.taskId);
    const unsettled = await db.query.taskEvents.findMany({
      where: and(
        eq(schema.taskEvents.taskId, meta.taskId),
        eq(schema.taskEvents.eventType, FIX_TEST_AFTER),
      ),
    });
    expect(unsettled).toHaveLength(0);
    await finishFixTestCapture(db, meta.invocationId);
    await writeFile(join(meta.workspace, 'tests/a.test.ts'), 'later sibling edit');
    await end(next!.id);
    await finishFixTestCapture(db, next!.id);
    const records = await loadFixTestRecords(db, meta.taskId);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.state === 'captured')).toBe(true);
    expect(records[0]!.changes[0]!.patch).toContain('+legitimate sibling edit');
    expect(records[1]!.changes[0]!.patch).toContain('+later sibling edit');
    const settled = await db.query.taskEvents.findMany({
      where: and(
        eq(schema.taskEvents.taskId, meta.taskId),
        eq(schema.taskEvents.eventType, FIX_TEST_AFTER),
      ),
    });
    expect(settled.every((e) => !e.payload?.protectedChanged)).toBe(true);
  });

  it.each(['superseded', 'stopped', 'failed', 'step reset', 'epoch moved'] as const)(
    'taints a %s repair before the next pass can retain moved content',
    async (terminal) => {
      const meta = await seed();
      // An opaque moved value intentionally has no scanner shape: terminal taint is
      // independent of content redaction and protects unknown credential formats too.
      const secret = randomBytes(24).toString('hex');
      await writeFile(join(meta.workspace, 'tests/.env.test'), secret);
      await beginFixTestCapture(db, meta);
      await rm(join(meta.workspace, 'tests/.env.test'));
      await writeFile(join(meta.workspace, 'tests/config.json'), secret);
      await db
        .update(schema.cliInvocations)
        .set({
          ...(['superseded', 'stopped'].includes(terminal) ? { supersededAt: new Date() } : {}),
          ...(terminal !== 'superseded'
            ? { endedAt: new Date(), exitCode: terminal === 'failed' ? 1 : 137 }
            : {}),
        })
        .where(eq(schema.cliInvocations.id, meta.invocationId));
      await db
        .update(schema.taskSteps)
        .set({ status: terminal === 'epoch moved' ? 'waiting_cli' : 'failed' })
        .where(eq(schema.taskSteps.id, meta.taskStepId));
      await db
        .update(schema.tasks)
        .set({ status: 'running', orchestrationEpoch: terminal === 'step reset' ? 0 : 1 })
        .where(eq(schema.tasks.id, meta.taskId));
      // The old pass is never handed back to resolveLlmPhase after Stop/Retry.
      await db
        .update(schema.tasks)
        .set({ status: 'running' })
        .where(eq(schema.tasks.id, meta.taskId));
      if (terminal !== 'step reset')
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_cli' })
          .where(eq(schema.taskSteps.id, meta.taskStepId));
      // Reconcile while the reset row still proves loss of ownership.
      if (terminal === 'step reset') {
        await loadFixTestRecords(db, meta.taskId);
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_cli' })
          .where(eq(schema.taskSteps.id, meta.taskStepId));
      }
      const [next] = await db
        .insert(schema.cliInvocations)
        .values({
          taskId: meta.taskId,
          taskStepId: meta.taskStepId,
          mode: 'cli',
          prompt: 'next',
        })
        .returning();
      await beginFixTestCapture(db, {
        ...meta,
        invocationId: next!.id,
        pass: 2,
        epoch: terminal === 'step reset' ? 0 : 1,
      });
      await writeFile(join(meta.workspace, 'tests/config.json'), `${secret} edited`);
      await end(next!.id);
      await finishFixTestCapture(db, next!.id);
      const events = await db.query.taskEvents.findMany({
        where: eq(schema.taskEvents.taskId, meta.taskId),
      });
      const closed = events.find(
        (e) => e.eventType === FIX_TEST_AFTER && e.payload?.invocationId === meta.invocationId,
      );
      expect(closed?.payload).toMatchObject({ state: 'not captured', protectedChanged: true });
      const blobs = await db
        .select()
        .from(schema.fixTestBlobs)
        .where(
          and(
            eq(schema.fixTestBlobs.taskId, meta.taskId),
            isNull(schema.fixTestBlobs.manifestGzip),
          ),
        );
      expect(blobs).toHaveLength(0);
      expect(JSON.stringify(await loadFixTestRecords(db, meta.taskId))).not.toContain(secret);
    },
  );

  it('taints an unmeasurable after capture even without a known protected endpoint', async () => {
    const meta = await seed();
    await beginFixTestCapture(db, meta);
    await end(meta.invocationId);
    await finishFixTestCapture(db, meta.invocationId, {
      capture: async () => ({ state: 'not captured', reason: 'Injected unreadable directory.' }),
    });
    const after = await db.query.taskEvents.findFirst({
      where: and(
        eq(schema.taskEvents.taskId, meta.taskId),
        eq(schema.taskEvents.eventType, FIX_TEST_AFTER),
      ),
    });
    expect(after?.payload).toMatchObject({ state: 'not captured', protectedChanged: true });
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
    expect(events.map((e) => e.eventType)).toEqual([FIX_TEST_BEFORE, FIX_TEST_AFTER]);
    expect(events[1]!.payload).toMatchObject({ state: 'not captured', protectedChanged: true });
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

// Insight batches use the same dedicated database and real row-lock fence as repair evidence.
describe.skipIf(!url)('manual insight batch journal on Postgres', () => {
  let db: Database;
  let userId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });
  const selected = [
    {
      id: `insight-v1-${createHash('sha256')
        .update(JSON.stringify(['one', 'a.ts']))
        .digest('hex')}`,
      legacyId: 'i-1',
      identity: 'a.ts::one',
      picked: false,
      title: 'One',
      location: 'a.ts',
      description: 'detail',
      sourceStep: 'review',
    },
  ];
  async function seed() {
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'workflow', title: 'insights', status: 'running' })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '08e-insights-triage',
        stepIndex: 8.95,
        title: 'Insights',
        status: 'running',
        round: 0,
      })
      .returning();
    return {
      db,
      taskId: task!.id,
      taskStepId: step!.id,
      userId,
      epoch: 0,
      rerunGeneration: 0,
      round: 0,
      throwIfCancelled() {},
    } as unknown as StepContext;
  }
  it.each(
    [
      'preAnswerDefaults',
      'preAnswers',
      'prior-task reuse',
      'autoContinue',
      'form autoSubmit',
      'step defaults',
      'saved synthetic answer',
      'job answer',
      'persisted preset schema',
    ].flatMap((source) => [[source, true] as const, [source, false] as const]),
  )('INS5 fresh approval: %s (latched=%s)', async (source, latched) => {
    const ctx = await seed();
    const gateId = '09-gate-2-verify-approval';
    const preset = { [gateId]: { decision: 'approve' } };
    let preAnswers = source === 'preAnswers' ? preset : {};
    let type = 'workflow';
    if (source === 'preAnswerDefaults') {
      type = `ins5-${randomUUID()}`;
      const [definition] = await db
        .insert(schema.taskTypeDefinitions)
        .values({
          slug: type,
          displayName: 'Insight approval preset',
          source: 'admin',
          runListStrategy: 'static',
          stepIds: [gateId],
          preAnswerDefaults: preset,
        })
        .returning();
      // Task creation copies these defaults; the worker must distrust that copy too.
      preAnswers = definition!.preAnswerDefaults!;
    }
    await db
      .update(schema.tasks)
      .set({
        type,
        currentStepId: gateId,
        currentRound: 0,
        autoContinue: source !== 'form autoSubmit',
        preAnswers,
      })
      .where(eq(schema.tasks.id, ctx.taskId));
    await db
      .update(schema.taskSteps)
      .set({
        stepId: gateId,
        status: 'pending',
        detectOutput: {},
        formValues: source === 'saved synthetic answer' ? { decision: 'approve' } : null,
      })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    if (latched)
      await db.insert(schema.taskEvents).values({
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        eventType: 'insight.check',
        payload: { version: 1, batchId: 'failed-batch', kind: 'verify_failed' },
      });
    const apply = vi.fn(async (_ctx, args) => ({ decision: args.formValues.decision }));
    const step: StepDefinition = {
      metadata: {
        id: gateId,
        index: 9,
        workflowType: 'workflow',
        title: 'Gate 2',
        description: '',
        requiresCli: false,
        autoSubmitDefaults: source === 'step defaults',
        reuseLastCompletedFormValues: source === 'prior-task reuse',
      },
      form: () => ({
        title: 'Gate 2',
        autoSubmit: source === 'form autoSubmit',
        fields: [
          {
            id: 'decision',
            type: 'radio',
            label: 'Decision',
            required: true,
            options: [
              { value: 'approve', label: 'Approve' },
              { value: 'reject', label: 'Reject' },
            ],
            default: latched ? 'reject' : 'approve',
          },
        ],
      }),
      apply,
    };
    if (source === 'persisted preset schema') {
      const oldForm = step.form!(ctx, {}, null)!;
      const decision = oldForm.fields[0]!;
      if (decision.type === 'radio') decision.default = 'approve';
      await db
        .update(schema.taskSteps)
        .set({ formSchema: oldForm })
        .where(eq(schema.taskSteps.id, ctx.taskStepId));
    }
    // A prior task's answer is read only with a matching repository and type.
    if (source === 'prior-task reuse') {
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'ins5 approval',
          source: 'blank',
          storagePath: '/unused',
          localPath: '/unused',
        })
        .returning();
      await db
        .update(schema.tasks)
        .set({ repositoryId: repo!.id })
        .where(eq(schema.tasks.id, ctx.taskId));
      const [prior] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: repo!.id,
          type,
          title: 'prior',
          status: 'completed',
          completedAt: new Date(),
        })
        .returning();
      await db.insert(schema.taskSteps).values({
        taskId: prior!.id,
        stepId: gateId,
        stepIndex: 9,
        title: 'Gate 2',
        status: 'done',
        formValues: { decision: 'approve' },
      });
    }
    const params = {
      db,
      taskId: ctx.taskId,
      userId,
      repoPath: '/unused',
      workspacePath: '/unused',
      cliProviderId: null,
      stepDef: step,
      epoch: 0,
      round: 0,
      moduleDeactivation: null,
      ...(source === 'job answer' ? { formValues: { decision: 'approve' } } : {}),
    };
    try {
      const result = await advanceStep(params);
      if (!latched) {
        expect(result.status).toBe(
          ['autoContinue', 'persisted preset schema'].includes(source) ? 'waiting_form' : 'done',
        );
        expect(
          (result.row.formSchema as { fields: { default?: unknown }[] }).fields[0]!.default,
        ).toBe('approve');
        expect(await pendingInsightApproval(db, ctx.taskId)).toBeNull();
        if (!['autoContinue', 'persisted preset schema'].includes(source))
          expect(apply).toHaveBeenCalledOnce();
        return;
      }
      expect(result.status).toBe('waiting_form');
      expect(result.row.formValues).toBeNull();
      expect(result.row.waitingStartedAt).not.toBeNull();
      expect(
        (result.row.formSchema as { fields: { default?: unknown }[] }).fields[0]!.default,
      ).toBe('reject');
      expect((result.row.formSchema as { autoSubmit?: boolean }).autoSubmit).toBe(false);
      expect(apply).not.toHaveBeenCalled();
      expect(await pendingInsightApproval(db, ctx.taskId)).toBe('failed-batch');
      await expect(
        recordGate3Check(
          db,
          {
            taskId: ctx.taskId,
            userId,
            orchestrationEpoch: 0,
          },
          result.row,
          'gate2_approved',
        ),
      ).rejects.toThrow(/fresh owner gate-2 submission/);
      if (source === 'autoContinue') {
        for (const invalid of [
          'owner',
          'generation',
          'row',
          'legacy',
          'before failure',
          'omitted decision',
        ]) {
          await db
            .delete(schema.taskEvents)
            .where(
              and(
                eq(schema.taskEvents.taskId, ctx.taskId),
                eq(schema.taskEvents.eventType, 'step.form_submitted'),
              ),
            );
          await db
            .update(schema.taskSteps)
            .set({ formValues: { decision: 'approve' }, waitingStartedAt: null })
            .where(eq(schema.taskSteps.id, ctx.taskStepId));
          await db.insert(schema.taskEvents).values({
            taskId: ctx.taskId,
            taskStepId: invalid === 'row' ? null : ctx.taskStepId,
            eventType: 'step.form_submitted',
            ...(invalid === 'before failure' ? { createdAt: new Date(0) } : {}),
            payload:
              invalid === 'legacy'
                ? { stepId: gateId, fieldCount: 1 }
                : {
                    userId: invalid === 'owner' ? randomUUID() : userId,
                    generation: invalid === 'generation' ? 1 : 0,
                    ...(invalid === 'omitted decision' ? {} : { decision: 'approve' }),
                  },
          });
          const refused = await advanceStep(params);
          expect(refused.status, invalid).toBe('waiting_form');
          expect(await pendingInsightApproval(db, ctx.taskId), invalid).toBe('failed-batch');
          expect(apply, invalid).not.toHaveBeenCalled();
        }
      }
      // This is the submit route's atomic answer + structural attestation. The API
      // route control independently proves the authenticated writer emits it.
      await db.transaction(async (tx) => {
        await tx
          .update(schema.taskSteps)
          .set({ formValues: { decision: 'approve' }, waitingStartedAt: null })
          .where(eq(schema.taskSteps.id, ctx.taskStepId));
        await tx.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          taskStepId: ctx.taskStepId,
          eventType: 'step.form_submitted',
          payload: { userId, generation: 0, decision: 'approve' },
        });
      });
      // A forged queue answer cannot replace the owner's saved decision.
      expect(await advanceStep({ ...params, formValues: { decision: 'reject' } })).toMatchObject({
        status: 'done',
        output: { decision: 'approve' },
      });
      expect(await pendingInsightApproval(db, ctx.taskId)).toBeNull();
      expect(apply).toHaveBeenCalledOnce();
      if (source === 'preAnswers') {
        const workspace = await mkdtemp(join(tmpdir(), 'ins5-approved-commit-'));
        try {
          await gitExec(['init'], { cwd: workspace });
          await gitExec(
            [
              '-c',
              'user.name=Test',
              '-c',
              'user.email=test@haive.local',
              'commit',
              '--allow-empty',
              '-m',
              'base',
            ],
            { cwd: workspace },
          );
          await writeFile(join(workspace, 'approved.txt'), 'approved improvement\n');
          const { gate3CommitStep } =
            await import('../src/step-engine/steps/workflow/10-gate-3-commit.js');
          const commitCtx = {
            ...ctx,
            repoPath: workspace,
            workspacePath: workspace,
            logger: { info() {}, warn() {}, error() {}, debug() {} },
          } as unknown as StepContext;
          const committed = await gate3CommitStep.apply(commitCtx, {
            detected: { hasGit: true, workspacePath: workspace },
            formValues: { commit: true, commitMessage: 'Apply approved improvement' },
          } as never);
          expect(committed).toMatchObject({ committed: true });
          expect(
            (await gitExec(['log', '-1', '--format=%s'], { cwd: workspace })).stdout.trim(),
          ).toBe('Apply approved improvement');
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }
    } finally {
      // User cascade removes the tasks, but the custom type has no owner FK.
      if (source === 'preAnswerDefaults') {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, ctx.taskId));
        await db
          .delete(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, type));
      }
    }
  });
  it.each(
    [
      'task preset',
      'type default',
      'prior reuse',
      'form autoSubmit',
      'step defaults',
      'saved synthetic',
      'queue answer',
      'persisted schema',
    ].flatMap((source) => [[source, true] as const, [source, false] as const]),
  )('gate3 refreshed approval: %s (cycle=%s)', async (source, cycle) => {
    const ctx = await seed();
    const gateId = '10-gate-3-commit';
    const preset = { [gateId]: { commit: true, commitMessage: 'preset message' } };
    let type = 'workflow';
    let preAnswers = source === 'task preset' ? preset : {};
    if (source === 'type default') {
      type = `g3i-${randomUUID()}`;
      const [definition] = await db
        .insert(schema.taskTypeDefinitions)
        .values({
          slug: type,
          displayName: 'Commit preset',
          source: 'admin',
          runListStrategy: 'static',
          stepIds: [gateId],
          preAnswerDefaults: preset,
        })
        .returning();
      preAnswers = definition!.preAnswerDefaults!;
    }
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'commit preset',
        source: 'blank',
        storagePath: '/unused',
        localPath: '/unused',
      })
      .returning();
    await db
      .update(schema.tasks)
      .set({
        type,
        repositoryId: repo!.id,
        currentStepId: gateId,
        currentRound: 0,
        autoContinue: source !== 'form autoSubmit',
        preAnswers,
      })
      .where(eq(schema.tasks.id, ctx.taskId));
    await db
      .update(schema.taskSteps)
      .set({
        stepId: gateId,
        status: 'pending',
        detectOutput: {},
        formValues: source === 'saved synthetic' ? { commit: true } : null,
      })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    if (cycle) {
      await db.insert(schema.taskEvents).values({
        taskId: ctx.taskId,
        eventType: 'insight.check',
        payload: { version: 1, batchId: 'picked', kind: 'verify_failed', round: 0 },
      });
      const [approval] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: ctx.taskId,
          stepId: '09-gate-2-verify-approval',
          stepIndex: 9,
          title: 'Approval',
          status: 'done',
          formValues: { decision: 'approve' },
          output: { decision: 'approve' },
        })
        .returning();
      await db.insert(schema.taskEvents).values({
        taskId: ctx.taskId,
        taskStepId: approval!.id,
        eventType: 'step.form_submitted',
        payload: { userId, generation: 0, decision: 'approve' },
      });
      await db
        .update(schema.tasks)
        .set({ currentStepId: approval!.stepId })
        .where(eq(schema.tasks.id, ctx.taskId));
      await recordGate3Check(
        db,
        { taskId: ctx.taskId, userId, orchestrationEpoch: 0 } as ResolvedTaskContext,
        approval!,
        'gate2_approved',
      );
      await db
        .update(schema.tasks)
        .set({ currentStepId: gateId })
        .where(eq(schema.tasks.id, ctx.taskId));
      expect(await pendingInsightApproval(db, ctx.taskId)).toBeNull();
    }
    if (source === 'prior reuse') {
      const [prior] = await db
        .insert(schema.tasks)
        .values({
          userId,
          repositoryId: repo!.id,
          type,
          title: 'prior',
          status: 'completed',
          completedAt: new Date(),
        })
        .returning();
      await db.insert(schema.taskSteps).values({
        taskId: prior!.id,
        stepId: gateId,
        stepIndex: 10,
        title: 'Commit',
        status: 'done',
        formValues: { commit: true },
      });
    }
    const apply = vi.fn(async () => ({ committed: true }));
    const reconcile = vi.fn((_ctx, _detected, values) => values);
    const step: StepDefinition = {
      metadata: {
        id: gateId,
        index: 10,
        workflowType: 'workflow',
        title: 'Commit',
        description: '',
        requiresCli: false,
        reuseLastCompletedFormValues: source === 'prior reuse',
        autoSubmitDefaults: source === 'step defaults',
      },
      reconcileReusedFormValues: reconcile,
      form: () => ({
        title: 'Commit',
        autoSubmit: source === 'form autoSubmit',
        fields: [
          { id: 'commit', type: 'checkbox', label: 'Commit', default: true },
          { id: 'commitMessage', type: 'textarea', label: 'Message', default: 'fresh message' },
        ],
      }),
      apply,
    };
    if (source === 'persisted schema')
      await db
        .update(schema.taskSteps)
        .set({
          formSchema: { ...step.form!(ctx, {}, null), autoSubmit: true },
        })
        .where(eq(schema.taskSteps.id, ctx.taskStepId));
    const params = {
      db,
      taskId: ctx.taskId,
      userId,
      repoPath: '/unused',
      workspacePath: '/unused',
      cliProviderId: null,
      stepDef: step,
      epoch: 0,
      round: 0,
      moduleDeactivation: null,
      ...(source === 'queue answer' ? { formValues: { commit: true } } : {}),
    };
    try {
      const result = await advanceStep(params);
      expect(result.status).toBe(cycle ? 'waiting_form' : 'done');
      if (!cycle) {
        expect(apply).toHaveBeenCalledOnce();
        return;
      }
      expect(result.row.waitingStartedAt).not.toBeNull();
      expect(result.row.formValues).toBeNull();
      expect(result.row.formSchema).toMatchObject({
        autoSubmit: false,
        fields: expect.arrayContaining([
          expect.objectContaining({ id: 'commit', default: true }),
          expect.objectContaining({ id: 'commitMessage', default: 'fresh message' }),
          expect.objectContaining({ id: 'reopenedFormNotice', type: 'note', variant: 'warning' }),
        ]),
      });
      expect(apply).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      // Resume and boot re-entry use the persisted waiting_form row. Retry resets it.
      for (const reentry of ['Resume', 'boot', 'Retry']) {
        let epoch = 0;
        if (reentry === 'Retry') {
          const reset = await resetStepAndDownstream(db, ctx.taskId, gateId, 0, 0);
          if (reset && reset !== 'superseded') epoch = reset.newEpoch;
        }
        const parked = await advanceStep({ ...params, epoch });
        expect(parked.status, reentry).toBe('waiting_form');
        expect(parked.row.waitingStartedAt, reentry).not.toBeNull();
        expect(apply, reentry).not.toHaveBeenCalled();
      }
      const row = await db.query.taskSteps.findFirst({
        where: eq(schema.taskSteps.id, ctx.taskStepId),
      });
      await db.transaction(async (tx) => {
        await tx
          .update(schema.taskSteps)
          .set({ formValues: { commit: true }, waitingStartedAt: null })
          .where(eq(schema.taskSteps.id, row!.id));
        await tx.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          taskStepId: row!.id,
          eventType: 'step.form_submitted',
          payload: {
            stepId: gateId,
            fieldCount: 1,
            userId,
            generation: row!.rerunGeneration,
            commit: true,
          },
        });
      });
      expect(await advanceStep({ ...params, epoch: 1 })).toMatchObject({ status: 'done' });
      expect(apply).toHaveBeenCalledOnce();
    } finally {
      if (source === 'type default') {
        await db.delete(schema.tasks).where(eq(schema.tasks.type, type));
        await db
          .delete(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, type));
      }
    }
  });
  it.each(['wrong user', 'wrong generation', 'commit mismatch', 'older submission'])(
    'gate3 stays parked with invalid human evidence: %s',
    async (kind) => {
      const ctx = await seed();
      const gateId = '10-gate-3-commit';
      await db
        .update(schema.tasks)
        .set({
          currentStepId: gateId,
          currentRound: 0,
          autoContinue: true,
          preAnswers: { [gateId]: { commit: true } },
        })
        .where(eq(schema.tasks.id, ctx.taskId));
      await db
        .update(schema.taskSteps)
        .set({
          stepId: gateId,
          status: 'waiting_form',
          detectOutput: {},
          formValues: { commit: true },
          waitingStartedAt: null,
        })
        .where(eq(schema.taskSteps.id, ctx.taskStepId));
      const approvedAt = new Date('2026-01-02T00:00:00Z');
      await db.insert(schema.taskEvents).values({
        taskId: ctx.taskId,
        eventType: 'insight.check',
        createdAt: approvedAt,
        payload: { version: 1, batchId: 'picked', kind: 'gate2_approved', round: 0 },
      });
      await db.insert(schema.taskEvents).values({
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        eventType: 'step.form_submitted',
        createdAt: new Date(
          kind === 'older submission' ? '2026-01-01T00:00:00Z' : '2026-01-03T00:00:00Z',
        ),
        payload: {
          userId: kind === 'wrong user' ? randomUUID() : userId,
          generation: kind === 'wrong generation' ? 1 : 0,
          commit: kind !== 'commit mismatch',
        },
      });
      const apply = vi.fn(async () => ({ committed: true }));
      const result = await advanceStep({
        db,
        taskId: ctx.taskId,
        userId,
        repoPath: '/unused',
        workspacePath: '/unused',
        cliProviderId: null,
        epoch: 0,
        round: 0,
        moduleDeactivation: null,
        formValues: { commit: true },
        stepDef: {
          metadata: {
            id: gateId,
            index: 10,
            workflowType: 'workflow',
            title: 'Commit',
            description: '',
            requiresCli: false,
            autoSubmitDefaults: true,
          },
          form: () => ({
            title: 'Commit',
            autoSubmit: true,
            fields: [{ id: 'commit', type: 'checkbox', label: 'Commit', default: true }],
          }),
          apply,
        },
      });
      expect(result.status).toBe('waiting_form');
      expect(result.row.waitingStartedAt).not.toBeNull();
      expect(result.row.formValues).toBeNull();
      expect(apply).not.toHaveBeenCalled();
    },
  );
  it.each([
    'declined',
    'justified',
    'touched',
    'mixed',
    'unconfirmed',
    'unreadable',
    'missing baseline',
    'legacy baseline',
    'incomplete baseline',
  ])('gate3 decline routing checks the actual tree: %s', async (kind) => {
    const ctx = await seed();
    const workspace = await mkdtemp(join(tmpdir(), 'g3i-outcome-'));
    try {
      await gitExec(['init'], { cwd: workspace });
      await writeFile(join(workspace, 'a.ts'), 'base');
      await gitExec(['add', '.'], { cwd: workspace });
      await gitExec(
        ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'base'],
        { cwd: workspace },
      );
      await writeFile(join(workspace, 'a.ts'), 'pending approved changes');
      await db.insert(schema.taskSteps).values({
        taskId: ctx.taskId,
        stepId: '01-worktree-setup',
        stepIndex: 1,
        title: 'Setup',
        status: 'done',
        output: { worktreePath: workspace },
      });
      const picks = kind === 'mixed' ? [...selected, { ...selected[0]!, id: 'two' }] : selected;
      const [gate] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: ctx.taskId,
          stepId: '10-gate-3-commit',
          stepIndex: 10,
          title: 'Commit',
          status: 'running',
          round: 0,
        })
        .returning();
      const baseline = await ensureInsightIntent({ ...ctx, taskStepId: gate!.id }, picks, 'gate3');
      const intent = await ensureInsightIntent(ctx, picks, 'gate3');
      if (kind === 'missing baseline') {
        await db
          .delete(schema.taskEvents)
          .where(
            and(
              eq(schema.taskEvents.taskId, ctx.taskId),
              eq(schema.taskEvents.taskStepId, gate!.id),
            ),
          );
      } else if (kind === 'legacy baseline' || kind === 'incomplete baseline') {
        const { worktreeBeforeDigest: _digest, ...legacy } = baseline;
        await db
          .update(schema.taskEvents)
          .set({
            payload: {
              ...legacy,
              ...(kind === 'legacy baseline'
                ? { worktreeBefore: { 'a.ts': 'legacy' } }
                : { worktreeBeforeDigest: { sha256: null, incomplete: true } }),
            },
          })
          .where(
            and(
              eq(schema.taskEvents.taskId, ctx.taskId),
              eq(schema.taskEvents.taskStepId, gate!.id),
            ),
          );
      }

      if (kind === 'touched')
        await writeFile(join(workspace, 'a.ts'), 'partial edit despite decline');
      const snapshot =
        kind === 'unreadable'
          ? vi.spyOn(validationSnapshots, 'readValidationSnapshot').mockResolvedValue(null)
          : null;
      let output;
      try {
        output = await insightsTriageStep.apply(
          { ...ctx, workspacePath: workspace, logger: { info() {} } } as unknown as StepContext,
          {
            detected: {
              worktreePath: workspace,
              sandboxWorktreePath: '/ws',
              spec: '',
              insights: picks,
              gate3Request: {
                version: 1,
                kind: 'insight_revise',
                batchId: baseline.batchId,
                sourceStepRow: gate!.id,
                generation: 0,
                round: 1,
                mode: 'gate3',
                stage: 'apply',
              },
            },
            formValues: {},
            llmOutput:
              kind === 'unconfirmed'
                ? 'invalid'
                : {
                    version: 1,
                    batchId: intent.batchId,
                    items: picks.map((i, n) => ({
                      id: i.id,
                      outcome: n === 1 ? 'applied' : 'not_applied',
                      changes: n === 1 ? ['edit'] : [],
                      reason: kind === 'justified' ? 'Outside scope' : '',
                    })),
                    notes: '',
                  },
            iteration: 0,
            previousIterations: [],
          },
        );
      } finally {
        snapshot?.mockRestore();
      }
      if (['declined', 'justified'].includes(kind)) {
        expect(output.continuation).toBeUndefined();
        expect(insightsTriageStep.reviseLoop!.evaluate(output)).toBeNull();
        expect(output).toMatchObject({
          checksSkipped: { reason: 'all_not_applied_unchanged', batchId: intent.batchId },
        });
        const replay = (await loadInsightBatchRecords(db, ctx.taskId)).find(
          (r) => r.stage === 'outcome',
        )!;
        expect(continuationForOutcome(replay, 0)).toBeUndefined();
      } else expect(output.continuation).toMatchObject({ mode: 'gate3', stage: 'checks' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it('gate3 writer crash then 08e Retry cannot skip checks on the first pass edits', async () => {
    const ctx = await seed();
    ctx.round = 1;
    await db
      .update(schema.taskSteps)
      .set({ round: 1 })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    await db
      .update(schema.tasks)
      .set({ currentStepId: '08e-insights-triage', currentRound: 1 })
      .where(eq(schema.tasks.id, ctx.taskId));
    const snapshot = vi
      .spyOn(validationSnapshots, 'readValidationSnapshot')
      .mockResolvedValue({ 'a.ts': 'approved' });
    try {
      const [gate] = await db
        .insert(schema.taskSteps)
        .values({
          taskId: ctx.taskId,
          stepId: '10-gate-3-commit',
          stepIndex: 10,
          title: 'Commit',
          status: 'running',
          round: 0,
        })
        .returning();
      const baseline = await ensureInsightIntent(
        { ...ctx, taskStepId: gate!.id, round: 0 },
        selected,
        'gate3',
      );
      const first = await ensureInsightIntent(ctx, selected, 'gate3');
      await recordInsightInvocation(
        ctx,
        `implementer-${first.batchId}`,
        'first-mining',
        'first-run',
      );
      // Writer pass 1 edits, then crashes before publishing any outcome.
      snapshot.mockResolvedValue({ 'a.ts': 'unchecked first pass edits' });
      await db
        .update(schema.taskSteps)
        .set({ status: 'done' })
        .where(eq(schema.taskSteps.id, gate!.id));
      await resetStepAndDownstream(db, ctx.taskId, '08e-insights-triage', 1, 0);
      await db
        .update(schema.taskSteps)
        .set({ status: 'running' })
        .where(eq(schema.taskSteps.id, ctx.taskStepId));
      const retry = {
        ...ctx,
        rerunGeneration: 1,
        epoch: 1,
        logger: { info() {} },
      } as unknown as StepContext;
      const second = await ensureInsightIntent(retry, selected, 'gate3');
      // Writer pass 2 declines every item and touches nothing.
      const output = await insightsTriageStep.apply(retry, {
        detected: {
          worktreePath: '/repo',
          sandboxWorktreePath: '/ws',
          spec: '',
          insights: selected,
          gate3Request: {
            version: 1,
            kind: 'insight_revise',
            mode: 'gate3',
            stage: 'apply',
            batchId: baseline.batchId,
            sourceStepRow: gate!.id,
            generation: 0,
            round: 1,
          },
        },
        formValues: {},
        iteration: 0,
        previousIterations: [],
        llmOutput: {
          version: 1,
          batchId: second.batchId,
          notes: '',
          items: [{ id: selected[0]!.id, outcome: 'not_applied', changes: [], reason: '' }],
        },
      });
      expect(output.continuation).toMatchObject({ mode: 'gate3', stage: 'checks' });
      expect(output.checksSkipped).toBeUndefined();
      const journal = await loadInsightBatchRecords(db, ctx.taskId);
      const raw = await db.query.taskEvents.findMany({
        where: and(
          eq(schema.taskEvents.taskId, ctx.taskId),
          eq(schema.taskEvents.eventType, 'insight.batch'),
        ),
      });
      for (const row of raw) {
        expect(row.payload).not.toHaveProperty('worktreeBefore');
        expect(JSON.stringify(row.payload?.worktreeBeforeDigest).length).toBeLessThan(110);
      }

      expect(journal.some((r) => r.batchId === first.batchId && r.stage === 'outcome')).toBe(false);
      expect(
        journal.find((r) => r.batchId === second.batchId && r.stage === 'outcome'),
      ).toMatchObject({ worktreeUnchanged: false });
    } finally {
      snapshot.mockRestore();
    }
  });
  it('deduplicates concurrent stages under the source-row lock', async () => {
    const ctx = await seed();
    const [a, b] = await Promise.all([
      ensureInsightIntent(ctx, selected),
      ensureInsightIntent(ctx, selected),
    ]);
    expect(a).toEqual(b);
    await Promise.all([
      recordInsightReservation(ctx, `implementer-${a.batchId}`, 'mining'),
      recordInsightReservation(ctx, `implementer-${a.batchId}`, 'mining'),
    ]);
    await Promise.all([
      recordInsightInvocation(ctx, `implementer-${a.batchId}`, 'mining', 'run'),
      recordInsightInvocation(ctx, `implementer-${a.batchId}`, 'mining', 'run'),
    ]);
    const outcome = {
      ...a,
      stage: 'outcome' as const,
      items: [
        { id: selected[0]!.id, outcome: 'applied' as const, changes: ['Edited a.ts'], reason: '' },
      ],
    };
    await Promise.all([appendInsightBatch(ctx, outcome), appendInsightBatch(ctx, outcome)]);
    expect((await loadInsightBatchRecords(db, ctx.taskId)).map((r) => r.stage).sort()).toEqual([
      'intent',
      'invocation',
      'outcome',
      'reservation',
    ]);
    await expect(
      recordInsightInvocation(ctx, `implementer-${a.batchId}`, 'other', 'other'),
    ).rejects.toThrow(/another invocation/);
  });
  it('retains an interrupted attempt and changes batch identity after explicit Retry', async () => {
    const ctx = await seed();
    const first = await ensureInsightIntent(ctx, selected);
    await db.insert(schema.taskStepAgentMinings).values({
      taskStepId: ctx.taskStepId,
      agentId: `implementer-${first.batchId}`,
      status: 'running',
    });
    const reset = await resetStepAndDownstream(db, ctx.taskId, '08e-insights-triage', 0, 0);
    expect(reset).toEqual({ downstreamReset: 0, newEpoch: 1 });
    const [row] = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    expect(row).toMatchObject({ rerunGeneration: 1, output: null, status: 'pending' });
    expect(
      await db
        .select()
        .from(schema.taskStepAgentMinings)
        .where(eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId)),
    ).toEqual([]);
    await db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    await expect(ensureInsightIntent(ctx, selected)).rejects.toMatchObject({
      name: 'StepSupersededError',
    });
    const second = await ensureInsightIntent({ ...ctx, rerunGeneration: 1, epoch: 1 }, selected);
    expect(second.batchId).not.toBe(first.batchId);
    const records = await loadInsightBatchRecords(db, ctx.taskId);
    expect(records).toHaveLength(2);
    expect(records[0]!.items[0]!.outcome).toBe('unconfirmed');
  });
  it.each(['intent', 'reservation', 'invocation', 'outcome'] as const)(
    'allows the in-flight %s write while paused',
    async (stage) => {
      const ctx = await seed();
      const intent = await ensureInsightIntent(ctx, selected);
      await db
        .update(schema.tasks)
        .set({ pausedAt: new Date() })
        .where(eq(schema.tasks.id, ctx.taskId));
      if (stage === 'intent')
        await expect(ensureInsightIntent(ctx, selected)).resolves.toEqual(intent);
      if (stage === 'reservation')
        await recordInsightReservation(ctx, `implementer-${intent.batchId}`, 'mining');
      if (stage === 'invocation')
        await recordInsightInvocation(ctx, `implementer-${intent.batchId}`, 'mining', 'run');
      if (stage === 'outcome')
        await appendInsightBatch(ctx, {
          ...intent,
          stage,
          items: intent.items.map((i) => ({ ...i, outcome: 'not_applied' })),
        });
      expect((await loadInsightBatchRecords(db, ctx.taskId)).some((r) => r.stage === stage)).toBe(
        true,
      );
    },
  );
  it.each(['Stop', 'dead', 'Cancel', 'epoch', 'foreign owner'])(
    'refuses %s at the journal fence',
    async (kind) => {
      const ctx = await seed();
      const patch =
        kind === 'Stop'
          ? { status: 'failed' as const }
          : kind === 'dead'
            ? { deadAt: new Date() }
            : kind === 'Cancel'
              ? { status: 'cancelled' as const }
              : kind === 'epoch'
                ? { orchestrationEpoch: 1 }
                : {};
      await db
        .update(schema.tasks)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.tasks.id, ctx.taskId));
      if (kind === 'foreign owner') ctx.userId = randomUUID();
      await expect(ensureInsightIntent(ctx, selected)).rejects.toMatchObject({
        name: 'StepSupersededError',
      });
      expect(await loadInsightBatchRecords(db, ctx.taskId)).toEqual([]);
    },
  );
  it('rolls back the mining row when the nested reservation journal write throws', async () => {
    const ctx = await seed();
    const intent = await ensureInsightIntent(ctx, selected);
    const agentId = `implementer-${intent.batchId}`;
    // The task id is a host-generated UUID. Reject only this test's reservation event.
    await db.execute(
      sql.raw(
        `ALTER TABLE task_events ADD CONSTRAINT insight_reservation_test CHECK (task_id <> '${ctx.taskId}'::uuid OR payload->>'stage' <> 'reservation')`,
      ),
    );
    try {
      await expect(
        db.transaction(async (tx) => {
          const [row] = await tx
            .insert(schema.taskStepAgentMinings)
            .values({ taskStepId: ctx.taskStepId, agentId, status: 'pending' })
            .returning();
          expect(await lockOwnedStep(tx, ctx.taskStepId)).toBe(true);
          await recordInsightReservation(
            { ...ctx, db: tx as unknown as Database },
            agentId,
            row!.id,
          );
        }),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      expect(
        await db
          .select()
          .from(schema.taskStepAgentMinings)
          .where(eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId)),
      ).toEqual([]);
      expect((await loadInsightBatchRecords(db, ctx.taskId)).map((r) => r.stage)).toEqual([
        'intent',
      ]);
    } finally {
      await db.execute(sql`ALTER TABLE task_events DROP CONSTRAINT insight_reservation_test`);
    }
  });
  it('required event failure blocks selectAgents before any dispatch can be reserved', async () => {
    const ctx = await seed();
    // A rejecting store seam is enough here; locking itself is exercised above on Postgres.
    const failing = {
      ...ctx,
      db: {
        transaction: async () => {
          throw new Error('journal unavailable');
        },
      },
    } as unknown as StepContext;
    await expect(
      insightsTriageStep.agentMining!.selectAgents({
        ctx: failing,
        detected: { insights: selected },
        formValues: { selectedInsights: [selected[0]!.id] },
        llmOutput: null,
      }),
    ).rejects.toThrow('journal unavailable');
    expect(
      await db
        .select()
        .from(schema.taskStepAgentMinings)
        .where(eq(schema.taskStepAgentMinings.taskStepId, ctx.taskStepId)),
    ).toEqual([]);
  });
  it('folds a real editor result once and replays the stored outcome after a lost done write', async () => {
    const ctx = await seed();
    ctx.logger = { info() {} } as never;
    const intent = await ensureInsightIntent(ctx, selected);
    const args = {
      detected: { insights: selected, worktreePath: '', sandboxWorktreePath: '', spec: '' },
      formValues: { selectedInsights: [selected[0]!.id] },
      llmOutput: null,
      iteration: 0,
      previousIterations: [],
      agentMiningResults: [
        {
          agentId: `implementer-${intent.batchId}`,
          agentTitle: 'Editor',
          status: 'done' as const,
          output: {
            version: 1,
            batchId: intent.batchId,
            items: [
              { id: selected[0]!.id, outcome: 'applied', changes: ['Changed a.ts'], reason: '' },
            ],
            notes: '',
          },
          rawOutput: null,
          errorMessage: null,
        },
      ],
    };
    const first = await insightsTriageStep.apply(ctx, args);
    const replay = await insightsTriageStep.apply(ctx, { ...args, agentMiningResults: [] });
    expect(first).toEqual(replay);
    expect(first.implemented).toBe(true);
    expect(first.continuation).toMatchObject({
      sourceStepRow: ctx.taskStepId,
      generation: 0,
      round: 1,
    });
    expect(
      (await loadInsightBatchRecords(db, ctx.taskId)).filter((r) => r.stage === 'outcome'),
    ).toHaveLength(1);
  });
  const routeSteps = [
    '07c-ddev-reconcile',
    '07b-phase-4-validate',
    '08-phase-5-verify',
    '08c-code-review',
    '08e-insights-triage',
    '09-gate-2-verify-approval',
    '10-gate-3-commit',
  ].map((id, index) => ({
    metadata: { id, index, workflowType: 'workflow' },
    editsCodeOrTests: id === '08e-insights-triage',
  })) as import('../src/step-engine/step-definition.js').StepDefinition[];
  async function seedRoute(stale = false, automatic = false) {
    const stepCtx = await seed();
    const intent = await ensureInsightIntent(
      stepCtx,
      selected,
      automatic ? 'auto_08e' : 'manual_08e',
    );
    const outcome = await appendInsightBatch(stepCtx, {
      ...intent,
      stage: 'outcome',
      items: intent.items.map((i) => ({ ...i, outcome: 'applied', changes: ['Edited a.ts'] })),
    });
    const continuation = continuationForOutcome(outcome, 0)!;
    const [source] = await db
      .update(schema.taskSteps)
      .set({ status: 'done', output: { continuation } })
      .where(eq(schema.taskSteps.id, stepCtx.taskStepId))
      .returning();
    await db
      .update(schema.tasks)
      .set({ currentStepId: source!.stepId, currentRound: 0 })
      .where(eq(schema.tasks.id, stepCtx.taskId));
    if (stale)
      for (const def of routeSteps
        .slice(2)
        .filter((s) => s.metadata.id !== '09-gate-2-verify-approval'))
        await db.insert(schema.taskSteps).values({
          taskId: stepCtx.taskId,
          stepId: def.metadata.id,
          stepIndex: def.metadata.index,
          runSeq: def.metadata.index,
          title: def.metadata.id,
          status: 'done',
          round: 1,
          output: { stale: true },
        });
    const ctx = { taskId: stepCtx.taskId, userId, orchestrationEpoch: 0 } as ResolvedTaskContext;
    return { ctx, source: source!, continuation };
  }
  async function seedGateInventory(ctx: StepContext) {
    await db.insert(schema.cliInvocations).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      mode: 'cli',
      prompt: 'review',
      rawOutput: '## INSIGHTS\n- INSIGHT: One | a.ts | detail',
    });
  }
  async function seedGatePick(stale = true) {
    const stepCtx = await seed();
    await seedGateInventory(stepCtx);
    await db
      .update(schema.taskSteps)
      .set({ stepId: '10-gate-3-commit' })
      .where(eq(schema.taskSteps.id, stepCtx.taskStepId));
    await db
      .update(schema.tasks)
      .set({ currentStepId: '10-gate-3-commit', currentRound: 0 })
      .where(eq(schema.tasks.id, stepCtx.taskId));
    const { gate3CommitStep } =
      await import('../src/step-engine/steps/workflow/10-gate-3-commit.js');
    const output = await gate3CommitStep.apply(stepCtx, {
      detected: { insightChoices: selected },
      formValues: { selectedInsights: [selected[0]!.id], commit: true },
      llmOutput: null,
    } as never);
    const continuation = gate3CommitStep.reviseLoop!.evaluate(output)!.continuation!;
    const [source] = await db
      .update(schema.taskSteps)
      .set({ status: 'done', output })
      .where(eq(schema.taskSteps.id, stepCtx.taskStepId))
      .returning();
    if (stale)
      for (const def of routeSteps
        .slice(2)
        .filter((s) => s.metadata.id !== '09-gate-2-verify-approval'))
        await db.insert(schema.taskSteps).values({
          taskId: stepCtx.taskId,
          stepId: def.metadata.id,
          stepIndex: def.metadata.index,
          title: def.metadata.id,
          status: 'done',
          round: 1,
          output: { stale: true },
        });
    return {
      ctx: { taskId: stepCtx.taskId, userId, orchestrationEpoch: 0 } as ResolvedTaskContext,
      source: source!,
      continuation,
    };
  }
  it.each([false, true])(
    'PR5 gate3 applies only the recorded pick, then resets verify/review/gate for fresh detection (auto=%s)',
    async (automatic) => {
      const { ctx, source, continuation } = await seedGatePick();
      const route = await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
      await db
        .update(schema.tasks)
        .set({ autoActOnInsights: automatic })
        .where(eq(schema.tasks.id, ctx.taskId));
      const [triage] = await db
        .update(schema.taskSteps)
        .set({ status: 'running' })
        .where(
          and(
            eq(schema.taskSteps.taskId, ctx.taskId),
            eq(schema.taskSteps.stepId, '08e-insights-triage'),
            eq(schema.taskSteps.round, 1),
          ),
        )
        .returning();
      const stepCtx = {
        db,
        taskId: ctx.taskId,
        userId,
        taskStepId: triage!.id,
        epoch: route!.epoch,
        rerunGeneration: triage!.rerunGeneration,
        round: 1,
        workspacePath: '/repo',
        sandboxWorkdir: '/ws',
        throwIfCancelled() {},
        logger: { info() {} },
      } as unknown as StepContext;
      const spec = vi
        .spyOn(specArtifacts, 'resolveSpecView')
        .mockResolvedValue({ text: '' } as never);
      const brief = vi.spyOn(specArtifacts, 'hydrateNoSpecBrief').mockResolvedValue(undefined);
      try {
        const detected = await insightsTriageStep.detect!(stepCtx);
        expect(detected).toMatchObject({
          gate3Request: continuation,
          insights: [{ id: selected[0]!.id }],
        });
        expect(detected.auto).toBeUndefined();
        expect(insightsTriageStep.form!(stepCtx, detected, null)).toMatchObject({
          fields: [],
          autoSubmit: true,
        });
        const agents = await insightsTriageStep.agentMining!.selectAgents({
          ctx: stepCtx,
          detected,
          formValues: { selectedInsights: ['stale'] },
          llmOutput: null,
        });
        expect(agents).toHaveLength(1);
        const batchId = insightBatchId(triage!.id, triage!.rerunGeneration);
        const output = await insightsTriageStep.apply(stepCtx, {
          detected,
          formValues: {},
          llmOutput: {
            version: 1,
            batchId,
            items: [{ id: selected[0]!.id, outcome: 'applied', changes: ['Edited'], reason: '' }],
            notes: '',
          },
          iteration: 0,
          previousIterations: [],
        });
        expect(output.continuation).toMatchObject({ mode: 'gate3', stage: 'checks', round: 2 });
        const [done] = await db
          .update(schema.taskSteps)
          .set({ status: 'done', output })
          .where(eq(schema.taskSteps.id, triage!.id))
          .returning();
        for (const step of routeSteps
          .slice(2)
          .filter((s) => s.metadata.id !== '09-gate-2-verify-approval'))
          await db.insert(schema.taskSteps).values({
            taskId: ctx.taskId,
            stepId: step.metadata.id,
            title: 'stale',
            stepIndex: step.metadata.index,
            round: 2,
            status: 'done',
            output: { stale: true },
            detectOutput: { diffSummary: 'old' },
            formSchema: { title: 'old', fields: [] },
          });
        const checks = await handoffInsightContinuation(
          db,
          { ...ctx, orchestrationEpoch: route!.epoch },
          done!,
          output.continuation!,
          routeSteps,
        );
        expect(checks).toMatchObject({ next: { metadata: { id: '08-phase-5-verify' } }, round: 2 });
        const fresh = await db.query.taskSteps.findMany({
          where: and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.round, 2)),
        });
        expect(fresh).toHaveLength(4);
        expect(
          fresh.every(
            (r) =>
              r.status === 'pending' &&
              r.output === null &&
              r.detectOutput === null &&
              r.formSchema === null,
          ),
        ).toBe(true);
        expect(await gate3InsightCycle(db, ctx.taskId, 2)).toMatchObject({ verifyFailed: false });
        const [verify] = await db
          .update(schema.taskSteps)
          .set({ status: 'done', output: { passed: false } })
          .where(eq(schema.taskSteps.id, fresh.find((r) => r.stepId === '08-phase-5-verify')!.id))
          .returning();
        await recordGate3Check(
          db,
          { ...ctx, orchestrationEpoch: checks!.epoch },
          verify!,
          'verify_failed',
        );
        // Resetting verify clears its output, but cannot clear the durable latch.
        await db
          .update(schema.taskSteps)
          .set({ status: 'pending', output: null, rerunGeneration: 2 })
          .where(eq(schema.taskSteps.id, verify!.id));
        expect(await gate3InsightCycle(db, ctx.taskId, 2)).toMatchObject({ verifyFailed: true });
        // Explicit Retry of the original gate invalidates the route, never the approval latch.
        await db
          .update(schema.taskSteps)
          .set({ rerunGeneration: 1, status: 'running' })
          .where(eq(schema.taskSteps.id, source.id));
        expect(await gate3InsightCycle(db, ctx.taskId, 2)).toBeNull();
        expect(await pendingInsightApproval(db, ctx.taskId)).not.toBeNull();
        const { gate3CommitStep } =
          await import('../src/step-engine/steps/workflow/10-gate-3-commit.js');
        const heldCommit = await gate3CommitStep.apply(stepCtx, {
          detected: {},
          formValues: { commit: true, commitMessage: 'must not commit' },
        } as never);
        expect(heldCommit).toMatchObject({ committed: false, approvalRequired: true });
        expect(gate3CommitStep.reviseLoop!.evaluate(heldCommit)).toEqual({
          targetStepId: '09-gate-2-verify-approval',
        });

        await db
          .update(schema.tasks)
          .set({ currentStepId: '09-gate-2-verify-approval' })
          .where(eq(schema.tasks.id, ctx.taskId));
        const [approval] = await db
          .insert(schema.taskSteps)
          .values({
            taskId: ctx.taskId,
            stepId: '09-gate-2-verify-approval',
            title: 'Approval',
            stepIndex: 9,
            round: 2,
            status: 'done',
            output: { decision: 'approve' },
            formValues: { decision: 'approve' },
          })
          .returning();
        await db.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          taskStepId: approval!.id,
          eventType: 'step.form_submitted',
          payload: { userId, generation: approval!.rerunGeneration, decision: 'approve' },
        });
        await recordGate3Check(
          db,
          { ...ctx, orchestrationEpoch: checks!.epoch },
          approval!,
          'gate2_approved',
        );
        expect(await pendingInsightApproval(db, ctx.taskId)).toBeNull();
      } finally {
        spec.mockRestore();
        brief.mockRestore();
      }
    },
  );
  it('PR5 complete report is immutable, survives completion, and keeps all items beyond the form page', async () => {
    const ctx = await seed();
    await db.insert(schema.cliInvocations).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      mode: 'cli',
      prompt: 'review',
      rawOutput:
        '## INSIGHTS\n' +
        Array.from({ length: 31 }, (_, n) => `- INSIGHT: Idea ${n} | f${n}.ts | optional`).join(
          '\n',
        ),
    });
    const id = await persistInsightReport(ctx);
    expect(await persistInsightReport(ctx)).toBe(id);
    await db
      .update(schema.tasks)
      .set({ status: 'completed' })
      .where(eq(schema.tasks.id, ctx.taskId));
    const report = await db.query.taskEvents.findFirst({ where: eq(schema.taskEvents.id, id) });
    expect(report?.payload?.items).toHaveLength(63);
    expect(JSON.stringify(report?.payload)).toContain('Idea 30');
  });
  it('PR5 the complete report keeps every alias attempt even with fewer journal rows than aliases', async () => {
    const ctx = await seed();
    await db.insert(schema.cliInvocations).values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      mode: 'cli',
      prompt: 'review',
      rawOutput:
        '## INSIGHTS\n' +
        Array.from({ length: 5 }, (_, n) => `- INSIGHT: One | a.ts:${n + 1} | optional`).join('\n'),
    });
    const inventory = await loadUnactedInsights(db, ctx.taskId, { includePicked: true });
    const intent = await ensureInsightIntent(ctx, inventory.insights, 'gate3');
    await appendInsightBatch(ctx, {
      ...intent,
      stage: 'outcome',
      items: intent.items.map((item, n) => ({
        ...item,
        outcome: n === 0 ? 'not_applied' : 'applied',
        changes: n === 0 ? [] : ['Edited'],
      })),
    });
    const reportId = await persistInsightReport(ctx);
    const report = await db.query.taskEvents.findFirst({
      where: eq(schema.taskEvents.id, reportId),
    });
    expect(report?.payload?.items).toHaveLength(12);
    const text = JSON.stringify(report?.payload).replaceAll('\\', '');
    for (const item of inventory.insights) expect(text).toContain(item.id);
    expect(text).toContain('mixed');
  });
  it('PR5 page navigation persists without a writer, survives reentry, and refuses Stop', async () => {
    const ctx = await seed();
    await expect(
      changeInsightPage(
        ctx,
        { insightTotal: 5, insightPageSize: 2 },
        { insightPage: '2', selectedInsights: [selected[0]!.id] },
      ),
    ).rejects.toMatchObject({ name: 'ReopenStepFormError' });
    expect(await insightPageOffset(ctx)).toBe(2);
    expect(await loadInsightBatchRecords(db, ctx.taskId)).toEqual([]);
    await db.update(schema.tasks).set({ status: 'failed' }).where(eq(schema.tasks.id, ctx.taskId));
    await expect(
      changeInsightPage(ctx, { insightTotal: 5, insightPageSize: 2 }, { insightPage: '4' }),
    ).rejects.toMatchObject({ name: 'StepSupersededError' });
    expect(await insightPageOffset(ctx)).toBe(2);
  });
  it('PR5 the actual gate definition through advanceStep journals a pick before any commit and replays it', async () => {
    const ctx = await seed();
    await seedGateInventory(ctx);
    const { gate3CommitStep } =
      await import('../src/step-engine/steps/workflow/10-gate-3-commit.js');
    const detected = {
      hasGit: false,
      workspacePath: '/repo',
      dirtyFiles: 0,
      diffSummary: '',
      diffArtifactPath: null,
      changedFileCount: 0,
      diffArtifactTruncated: false,
      insightChoices: selected,
    };
    const formValues = { selectedInsights: [selected[0]!.id], commit: true, commitMessage: '' };
    await db
      .update(schema.taskSteps)
      .set({
        stepId: gate3CommitStep.metadata.id,
        status: 'waiting_form',
        detectOutput: detected,
        formSchema: gate3CommitStep.form!(ctx, detected, null),
        formValues,
        startedAt: new Date(),
      })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    await db
      .update(schema.tasks)
      .set({ currentStepId: gate3CommitStep.metadata.id, currentRound: 0 })
      .where(eq(schema.tasks.id, ctx.taskId));
    const params = {
      db,
      taskId: ctx.taskId,
      userId,
      repoPath: '/repo',
      workspacePath: '/repo',
      cliProviderId: null,
      stepDef: gate3CommitStep,
      epoch: 0,
      round: 0,
      moduleDeactivation: null,
    };
    const result = await advanceStep(params);
    expect(result).toMatchObject({
      status: 'revise',
      targetStepId: '08e-insights-triage',
      continuation: { mode: 'gate3', stage: 'apply' },
    });
    expect(
      (await loadInsightBatchRecords(db, ctx.taskId)).filter((r) => r.stage === 'intent'),
    ).toHaveLength(1);
    expect(await hasCliWork(db, ctx.taskStepId, 0, '10-gate-3-commit')).toBe(true);
    expect(await advanceStep(params)).toMatchObject({ status: 'done' });
    expect(await finishedStepResult(db, ctx.taskId, gate3CommitStep, result.row)).toMatchObject({
      status: 'revise',
      continuation: (result as { continuation?: unknown }).continuation,
    });
  });
  async function gateCheckRound() {
    const { ctx, source, continuation } = await seedGatePick(false);
    const first = await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
    const [triage] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: ctx.taskId,
        stepId: '08e-insights-triage',
        stepIndex: 8.95,
        title: 'Editor',
        status: 'running',
        round: 1,
      })
      .returning();
    const stepCtx = {
      db,
      taskId: ctx.taskId,
      taskStepId: triage!.id,
      userId,
      epoch: first!.epoch,
      round: 1,
      rerunGeneration: 0,
      throwIfCancelled() {},
    } as StepContext;
    const intent = await ensureInsightIntent(stepCtx, selected, 'gate3');
    const outcome = await appendInsightBatch(stepCtx, {
      ...intent,
      stage: 'outcome',
      items: intent.items.map((i) => ({ ...i, outcome: 'applied', changes: ['Edited'] })),
    });
    const checksContinuation = continuationForOutcome(outcome, 1)!;
    const [done] = await db
      .update(schema.taskSteps)
      .set({ status: 'done', output: { continuation: checksContinuation } })
      .where(eq(schema.taskSteps.id, triage!.id))
      .returning();
    const checks = await handoffInsightContinuation(
      db,
      { ...ctx, orchestrationEpoch: first!.epoch },
      done!,
      checksContinuation,
      routeSteps,
    );
    return { ctx: { ...ctx, orchestrationEpoch: checks!.epoch }, round: 2 };
  }
  it.each(['failed command', 'hard failure'] as const)(
    'PR5 actual 08 runner latches %s before it leaves the row',
    async (kind) => {
      const { ctx, round } = await gateCheckRound();
      const workspace = await mkdtemp(join(tmpdir(), 'ins5-verify-'));
      const runtime = vi
        .spyOn(appRuntime, 'ensureAppServing')
        .mockResolvedValue({ mode: 'none' } as never);
      const command = vi
        .spyOn(stepCommands, 'runStepCommandInSandbox')
        .mockResolvedValue({ ran: true, exitCode: 1, output: 'isolated check failed' } as never);
      try {
        const detected = {
          workspacePath: workspace,
          ddevMode: false,
          test: {
            kind: 'host',
            argv: [process.execPath, '-e', 'process.exit(1)'],
            label: 'isolated failing check',
          },
          lint: null,
          typecheck: null,
        };
        await db.insert(schema.taskSteps).values({
          taskId: ctx.taskId,
          stepId: phase5VerifyStep.metadata.id,
          stepIndex: 8,
          title: 'Verify',
          status: 'pending',
          round,
          detectOutput: detected,
        });
        const result = await advanceStep({
          db,
          taskId: ctx.taskId,
          userId,
          repoPath: workspace,
          workspacePath: workspace,
          cliProviderId: null,
          stepDef:
            kind === 'failed command'
              ? phase5VerifyStep
              : {
                  ...phase5VerifyStep,
                  apply: async () => {
                    throw new Error('control: hard verification failure');
                  },
                },
          epoch: ctx.orchestrationEpoch,
          round,
          moduleDeactivation: null,
          formValues: { runTest: true, runLint: false, runTypecheck: false },
        });
        expect(result.status).toBe(kind === 'failed command' ? 'loop_back' : 'failed');
        if (kind === 'failed command')
          expect(result.row.output).toMatchObject({
            test: { ran: true, passed: false },
            passed: false,
          });
        expect(await pendingInsightApproval(db, ctx.taskId)).not.toBeNull();
      } finally {
        runtime.mockRestore();
        command.mockRestore();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
  it('all-not-applied gate3 batch advances straight to the refreshed gate without dispatching checks', async () => {
    const snapshot = vi
      .spyOn(validationSnapshots, 'readValidationSnapshot')
      .mockResolvedValue({ 'a.ts': 'same' });
    try {
      const { ctx, source, continuation } = await seedGatePick();
      const route = await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
      const [triage] = await db
        .update(schema.taskSteps)
        .set({ status: 'running' })
        .where(
          and(
            eq(schema.taskSteps.taskId, ctx.taskId),
            eq(schema.taskSteps.stepId, '08e-insights-triage'),
            eq(schema.taskSteps.round, route!.round),
          ),
        )
        .returning();
      const stepCtx = {
        db,
        taskId: ctx.taskId,
        userId,
        taskStepId: triage!.id,
        round: route!.round,
        rerunGeneration: triage!.rerunGeneration,
        epoch: route!.epoch,
        throwIfCancelled() {},
        logger: { info() {} },
      } as unknown as StepContext;
      const intent = await ensureInsightIntent(stepCtx, selected, 'gate3');
      const output = await insightsTriageStep.apply(stepCtx, {
        detected: {
          worktreePath: '/repo',
          sandboxWorktreePath: '/ws',
          spec: '',
          insights: selected,
          gate3Request: continuation,
        },
        formValues: {},
        llmOutput: {
          version: 1,
          batchId: intent.batchId,
          notes: '',
          items: [{ id: selected[0]!.id, outcome: 'not_applied', changes: [], reason: '' }],
        },
        iteration: 0,
        previousIterations: [],
      });
      const done = await publishInsightStep(stepCtx, {
        status: 'done',
        output,
        endedAt: new Date(),
      });
      const ids = routeSteps.map((s) => s.metadata.id);
      await db
        .update(schema.tasks)
        .set({ runListSnapshot: ids })
        .where(eq(schema.tasks.id, ctx.taskId));
      registerStepsOnce();
      testQueue.jobs = [];
      await handleResult(
        db,
        {
          ...ctx,
          workflowType: 'workflow',
          runListStrategy: 'static',
          runListSnapshot: ids,
          currentStepId: triage!.stepId,
          currentRound: route!.round,
          orchestrationEpoch: route!.epoch,
        } as ResolvedTaskContext,
        triage!.stepId,
        { status: 'done', row: done, output },
      );
      expect(testQueue.jobs).toMatchObject([{ stepId: '10-gate-3-commit', round: route!.round }]);
      expect(output).toMatchObject({ checksSkipped: { reason: 'all_not_applied_unchanged' } });
      expect(await activeInsightContinuation(db, ctx.taskId, route!.round)).toBeNull();
      expect(
        await db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) }),
      ).toMatchObject({
        currentStepId: '10-gate-3-commit',
        currentRound: route!.round,
      });
    } finally {
      snapshot.mockRestore();
      await closeTaskQueue();
    }
  });
  it.each([false, true])(
    'PR5 actual checkpoint preserves configured safety steps and skips only gate2 (extra check=%s)',
    async (extraCheck) => {
      const { ctx, round } = await gateCheckRound();
      const ids = routeSteps.map((s) => s.metadata.id);
      if (extraCheck) ids.splice(ids.indexOf('08e-insights-triage') + 1, 0, '08c2-code-audit');
      await db
        .update(schema.tasks)
        .set({ currentStepId: '08e-insights-triage', currentRound: round, runListSnapshot: ids })
        .where(eq(schema.tasks.id, ctx.taskId));
      registerStepsOnce();
      const result = await advanceStep({
        db,
        taskId: ctx.taskId,
        userId,
        repoPath: '/repo',
        workspacePath: '/repo',
        cliProviderId: null,
        stepDef: insightsTriageStep,
        epoch: ctx.orchestrationEpoch,
        round,
        moduleDeactivation: null,
      });
      expect(result.status).toBe('done');
      testQueue.jobs = [];
      try {
        await handleResult(
          db,
          {
            ...ctx,
            workflowType: 'workflow',
            runListStrategy: 'static',
            runListSnapshot: ids,
            currentStepId: '08e-insights-triage',
            currentRound: round,
          } as ResolvedTaskContext,
          '08e-insights-triage',
          result,
        );
        expect(
          await db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) }),
        ).toMatchObject({
          currentStepId: extraCheck ? '08c2-code-audit' : '10-gate-3-commit',
          currentRound: round,
        });
        expect(testQueue.jobs).toMatchObject([
          { stepId: extraCheck ? '08c2-code-audit' : '10-gate-3-commit', round },
        ]);
        if (extraCheck) {
          const [audit] = await db
            .insert(schema.taskSteps)
            .values({
              taskId: ctx.taskId,
              stepId: '08c2-code-audit',
              stepIndex: 8.8,
              title: 'Configured safety check',
              round,
              status: 'done',
              output: {},
            })
            .returning();
          await handleResult(
            db,
            {
              ...ctx,
              workflowType: 'workflow',
              runListStrategy: 'static',
              runListSnapshot: ids,
              currentStepId: audit!.stepId,
              currentRound: round,
            } as ResolvedTaskContext,
            audit!.stepId,
            { status: 'done', row: audit!, output: {} },
          );
          expect(testQueue.jobs.at(-1)).toMatchObject({ stepId: '10-gate-3-commit', round });
        }
        expect(
          await db.query.taskSteps.findFirst({
            where: and(
              eq(schema.taskSteps.taskId, ctx.taskId),
              eq(schema.taskSteps.stepId, '09-gate-2-verify-approval'),
            ),
          }),
        ).toBeUndefined();
      } finally {
        await closeTaskQueue();
      }
    },
  );
  type QaRow = { status: 'done' | 'skipped'; round: number; decision?: 'accept' | 'fix' };
  async function runInsightCheckWithQa(qa: QaRow[]) {
    const { ctx, round } = await gateCheckRound();
    const ids = routeSteps.map((s) => s.metadata.id);
    ids.splice(ids.indexOf('08e-insights-triage'), 0, '08d2-adversarial-qa-review');
    for (const row of qa)
      await db.insert(schema.taskSteps).values({
        taskId: ctx.taskId,
        stepId: '08d2-adversarial-qa-review',
        stepIndex: 8.92,
        title: 'Adversarial QA review',
        status: row.status,
        round: row.round,
        output: row.decision ? { decision: row.decision } : {},
      });
    await db
      .update(schema.tasks)
      .set({ currentStepId: '08e-insights-triage', currentRound: round, runListSnapshot: ids })
      .where(eq(schema.tasks.id, ctx.taskId));
    registerStepsOnce();
    const result = await advanceStep({
      db,
      taskId: ctx.taskId,
      userId,
      repoPath: '/repo',
      workspacePath: '/repo',
      cliProviderId: null,
      stepDef: insightsTriageStep,
      epoch: ctx.orchestrationEpoch,
      round,
      moduleDeactivation: null,
    });
    expect(result.status).toBe('done');
    testQueue.jobs = [];
    try {
      await handleResult(
        db,
        {
          ...ctx,
          workflowType: 'workflow',
          runListStrategy: 'static',
          runListSnapshot: ids,
          currentStepId: '08e-insights-triage',
          currentRound: round,
        } as ResolvedTaskContext,
        '08e-insights-triage',
        result,
      );
      const task = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) });
      return { task, jobs: [...testQueue.jobs], round };
    } finally {
      await closeTaskQueue();
    }
  }
  it('gate2 QA deferral: an accepted QA review this cycle keeps gate 2', async () => {
    const { task, jobs, round } = await runInsightCheckWithQa([
      { status: 'done', round: 2, decision: 'accept' },
    ]);
    expect(task).toMatchObject({ currentStepId: '09-gate-2-verify-approval', currentRound: round });
    expect(jobs).toMatchObject([{ stepId: '09-gate-2-verify-approval', round }]);
  });
  it.each([
    ['no QA row', []],
    ['QA skipped this cycle', [{ status: 'skipped', round: 2 }]],
    ['QA accepted before the cycle', [{ status: 'done', round: 0, decision: 'accept' }]],
    [
      'latest QA row skipped',
      [
        { status: 'done', round: 1, decision: 'accept' },
        { status: 'skipped', round: 2 },
      ],
    ],
  ] as [string, QaRow[]][])('gate2 QA deferral: still skips gate 2 with %s', async (_name, qa) => {
    const { task, jobs, round } = await runInsightCheckWithQa(qa);
    expect(task).toMatchObject({ currentStepId: '10-gate-3-commit', currentRound: round });
    expect(jobs).toMatchObject([{ stepId: '10-gate-3-commit', round }]);
  });
  it('gate2 QA deferral: accept after an earlier fix round keeps gate 2', async () => {
    const { task, jobs, round } = await runInsightCheckWithQa([
      { status: 'done', round: 1, decision: 'fix' },
      { status: 'done', round: 2, decision: 'accept' },
    ]);
    expect(task).toMatchObject({ currentStepId: '09-gate-2-verify-approval', currentRound: round });
    expect(jobs).toMatchObject([{ stepId: '09-gate-2-verify-approval', round }]);
  });
  describe('gate 3 after a gate-3 insight cycle', () => {
    const gateId = '10-gate-3-commit';
    const CYCLE_AT = new Date('2026-01-02T00:00:00Z');
    const ANSWER_AT = new Date('2026-01-03T00:00:00Z');
    const STAMPED = {
      stepId: gateId,
      fieldCount: 1,
    };
    /** A timestamp literal PostgreSQL keeps to the microsecond; a JavaScript Date cannot. */
    const microsecond = (iso: string) => sql`${iso}::timestamptz`;
    /** Answer times against a cycle event written at 00:00:00.000500: a day before, 100 microseconds
     *  before in the same millisecond, and 100 microseconds after in it. */
    const CYCLE_AT_MICRO = '2026-01-02T00:00:00.000500Z';
    const ANCHOR_CASES = [
      ['a day before the cycle', '2026-01-01T00:00:00.000500Z', 'waiting_form'],
      ['100 microseconds before the cycle', '2026-01-02T00:00:00.000400Z', 'waiting_form'],
      ['100 microseconds after the cycle', '2026-01-02T00:00:00.000600Z', 'done'],
    ] as const;

    async function addContinuationEvent(
      taskId: string,
      sourceRowId: string,
      round: number,
      opts: { createdAt?: Date | SQL; generation?: number } = {},
    ) {
      const [event] = await db
        .insert(schema.taskEvents)
        .values({
          taskId,
          taskStepId: sourceRowId,
          eventType: 'insight.continuation',
          ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
          payload: {
            continuation: {
              version: 1,
              kind: 'insight_revise',
              batchId: randomUUID(),
              sourceStepRow: sourceRowId,
              generation: opts.generation ?? 0,
              round,
              mode: 'gate3',
              stage: 'apply',
            },
            targetStepId: '08e-insights-triage',
          },
        })
        .returning();
      return event!;
    }

    async function addGate3Row(
      taskId: string,
      round: number,
      status: 'done' | 'skipped' | 'pending',
    ) {
      const [row] = await db
        .insert(schema.taskSteps)
        .values({
          taskId,
          stepId: gateId,
          stepIndex: 10,
          title: 'Commit',
          status,
          round,
          formValues: status === 'pending' ? null : { commit: true },
          output: status === 'pending' ? null : { committed: true },
        })
        .returning();
      return row!;
    }

    /** One pending gate-3 row at `round` with a task pre-answer, and the cycle the mode names. */
    async function seedGate3(mode: 'cycle' | 'none', round = 1, eventAt?: Date | SQL) {
      const ctx = await seed();
      const preset = { [gateId]: { commit: true, commitMessage: 'preset message' } };
      const [repo] = await db
        .insert(schema.repositories)
        .values({
          userId,
          name: 'commit preset',
          source: 'blank',
          storagePath: '/unused',
          localPath: '/unused',
        })
        .returning();
      await db
        .update(schema.tasks)
        .set({
          type: 'workflow',
          repositoryId: repo!.id,
          currentStepId: gateId,
          currentRound: round,
          autoContinue: true,
          preAnswers: preset,
        })
        .where(eq(schema.tasks.id, ctx.taskId));
      const sourceRow = await addGate3Row(ctx.taskId, round - 1, 'done');
      await db
        .update(schema.taskSteps)
        .set({ stepId: gateId, round, status: 'pending', detectOutput: {}, formValues: null })
        .where(eq(schema.taskSteps.id, ctx.taskStepId));
      if (mode === 'cycle')
        await addContinuationEvent(ctx.taskId, sourceRow.id, round, { createdAt: eventAt });
      const apply = vi.fn(async () => ({ committed: true }));
      const stepDef: StepDefinition = {
        metadata: {
          id: gateId,
          index: 10,
          workflowType: 'workflow',
          title: 'Commit',
          description: '',
          requiresCli: false,
        },
        form: () => ({
          title: 'Commit',
          fields: [
            { id: 'commit', type: 'checkbox', label: 'Commit', default: true },
            { id: 'commitMessage', type: 'textarea', label: 'Message', default: 'fresh message' },
          ],
        }),
        apply,
      };
      const params = {
        db,
        taskId: ctx.taskId,
        userId,
        repoPath: '/unused',
        workspacePath: '/unused',
        cliProviderId: null,
        stepDef,
        epoch: 0,
        round,
        moduleDeactivation: null,
      };
      return { ctx, params, apply, sourceRow };
    }

    const expectParked = (
      result: Awaited<ReturnType<typeof advanceStep>>,
      apply: ReturnType<typeof vi.fn>,
      label?: string,
    ) => {
      expect(result.status, label).toBe('waiting_form');
      expect(result.row.waitingStartedAt, label).not.toBeNull();
      expect(result.row.formValues, label).toBeNull();
      expect(result.row.formSchema, label).toMatchObject({
        autoSubmit: false,
        fields: expect.arrayContaining([
          expect.objectContaining({ id: 'commit', default: true }),
          expect.objectContaining({ id: 'reopenedFormNotice', type: 'note', variant: 'warning' }),
        ]),
      });
      expect(apply, label).not.toHaveBeenCalled();
    };

    /** What the submit route writes in one transaction when the owner answers a gate-3 form. */
    async function answerAsOwner(
      rowId: string,
      taskId: string,
      createdAt: Date | SQL = ANSWER_AT,
      generation = 0,
      answeredBy = userId,
    ) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.taskSteps)
          .set({ formValues: { commit: true }, waitingStartedAt: null })
          .where(eq(schema.taskSteps.id, rowId));
        await tx.insert(schema.taskEvents).values({
          taskId,
          taskStepId: rowId,
          eventType: 'step.form_submitted',
          createdAt,
          payload: { ...STAMPED, userId: answeredBy, generation, commit: true },
        });
      });
    }

    it('gate 3 parks after a clean cycle that went through the real handoff', async () => {
      const { ctx, round } = await gateCheckRound();
      const row = await addGate3Row(ctx.taskId, round, 'pending');
      await db
        .update(schema.tasks)
        .set({
          currentStepId: gateId,
          currentRound: round,
          autoContinue: true,
          preAnswers: { [gateId]: { commit: true } },
        })
        .where(eq(schema.tasks.id, ctx.taskId));
      const apply = vi.fn(async () => ({ committed: true }));
      const result = await advanceStep({
        db,
        taskId: ctx.taskId,
        userId,
        repoPath: '/unused',
        workspacePath: '/unused',
        cliProviderId: null,
        epoch: ctx.orchestrationEpoch,
        round,
        moduleDeactivation: null,
        formValues: { commit: true },
        stepDef: {
          metadata: {
            id: gateId,
            index: 10,
            workflowType: 'workflow',
            title: 'Commit',
            description: '',
            requiresCli: false,
            autoSubmitDefaults: true,
          },
          form: () => ({
            title: 'Commit',
            autoSubmit: true,
            fields: [{ id: 'commit', type: 'checkbox', label: 'Commit', default: true }],
          }),
          apply,
        },
      });
      expect(result.row.id).toBe(row.id);
      expect(result.status).toBe('waiting_form');
      expect(result.row.waitingStartedAt).not.toBeNull();
      expect(result.row.formValues).toBeNull();
      expect(apply).not.toHaveBeenCalled();
    });

    it('gate 3 parks after a second clean cycle whose first cycle was re-approved at gate 2', async () => {
      const { ctx, params, apply, sourceRow } = await seedGate3('none', 3);
      const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
      const firstSource = await addGate3Row(ctx.taskId, 0, 'done');
      await addContinuationEvent(ctx.taskId, firstSource.id, 1, { createdAt: at(1) });
      await db.insert(schema.taskEvents).values([
        {
          taskId: ctx.taskId,
          eventType: 'insight.check',
          createdAt: at(2),
          payload: { version: 1, batchId: 'first', kind: 'verify_failed', round: 1 },
        },
        {
          taskId: ctx.taskId,
          eventType: 'insight.check',
          createdAt: at(3),
          payload: { version: 1, batchId: 'first', kind: 'gate2_approved', round: 2 },
        },
      ]);
      await addContinuationEvent(ctx.taskId, sourceRow.id, 3, { createdAt: at(5) });
      expectParked(await advanceStep(params), apply);
    });

    describe('after a Retry reset the source row', () => {
      const upstreamId = '07-upstream-probe';

      /** A cycle the real handoff opened, then a Retry (the real reset) that re-runs the pick's own
       *  row at round 0, below the cycle's round: from a step above it, or from the row itself. */
      async function seedRetriedCycle(target: 'above' | 'self') {
        const pick = await seedGatePick(false);
        await handoffInsightContinuation(db, pick.ctx, pick.source, pick.continuation, routeSteps);
        const { taskId } = pick.ctx;
        const sourceId = pick.source.id;
        const [repo] = await db
          .insert(schema.repositories)
          .values({
            userId,
            name: 'commit preset',
            source: 'blank',
            storagePath: '/unused',
            localPath: '/unused',
          })
          .returning();
        await db
          .update(schema.tasks)
          .set({
            type: 'workflow',
            repositoryId: repo!.id,
            autoContinue: true,
            preAnswers: { [gateId]: { commit: true, commitMessage: 'preset message' } },
          })
          .where(eq(schema.tasks.id, taskId));
        if (target === 'above')
          await db.insert(schema.taskSteps).values({
            taskId,
            stepId: upstreamId,
            stepIndex: 1,
            title: 'Upstream',
            status: 'done',
            round: 0,
          });
        const retry = async () => {
          const reset = await resetStepAndDownstream(
            db,
            taskId,
            target === 'above' ? upstreamId : gateId,
            0,
          );
          if (!reset || reset === 'superseded') throw new Error('the reset did not apply');
          // What the api Retry also writes: the held form on the clicked row, the position.
          if (target === 'self')
            await db
              .update(schema.taskSteps)
              .set({ pauseFormOnRetry: true })
              .where(eq(schema.taskSteps.id, sourceId));
          await db
            .update(schema.tasks)
            .set({ currentStepId: gateId, currentRound: 0 })
            .where(eq(schema.tasks.id, taskId));
          return reset.newEpoch;
        };
        const apply = vi.fn(async () => ({ committed: true }));
        const stepDef: StepDefinition = {
          metadata: {
            id: gateId,
            index: 10,
            workflowType: 'workflow',
            title: 'Commit',
            description: '',
            requiresCli: false,
          },
          form: () => ({
            title: 'Commit',
            fields: [
              { id: 'commit', type: 'checkbox', label: 'Commit', default: true },
              { id: 'commitMessage', type: 'textarea', label: 'Message', default: 'fresh message' },
            ],
          }),
          apply,
        };
        const advance = (epoch: number, round = 0) =>
          advanceStep({
            db,
            taskId,
            userId,
            repoPath: '/unused',
            workspacePath: '/unused',
            cliProviderId: null,
            stepDef,
            epoch,
            round,
            moduleDeactivation: null,
          });
        const [event] = await db
          .select()
          .from(schema.taskEvents)
          .where(
            and(
              eq(schema.taskEvents.taskId, taskId),
              eq(schema.taskEvents.eventType, 'insight.continuation'),
            ),
          );
        return { taskId, sourceId, retry, advance, apply, cycleEventId: event!.id };
      }

      const expectHeld = (
        result: Awaited<ReturnType<typeof advanceStep>>,
        apply: ReturnType<typeof vi.fn>,
        label?: string,
      ) => {
        expect(result.status, label).toBe('waiting_form');
        expect(result.row.waitingStartedAt, label).not.toBeNull();
        expect(result.row.formValues, label).toBeNull();
        expect(apply, label).not.toHaveBeenCalled();
      };

      it.each(['above', 'self'] as const)(
        'a preset does not commit the re-run of the pick row after a Retry from %s',
        async (target) => {
          const { retry, advance, apply } = await seedRetriedCycle(target);
          const epoch = await retry();
          expectHeld(await advance(epoch), apply);
          // The held form was a one-shot; entering the parked row again must not commit either.
          expectHeld(await advance(epoch), apply, 'entered again');
        },
      );

      it.each(ANCHOR_CASES)(
        'an owner answer for the re-run %s needs to be newer than the cycle event to count',
        async (_name, answerAt, expected) => {
          const { taskId, sourceId, retry, advance, apply, cycleEventId } =
            await seedRetriedCycle('above');
          await db
            .update(schema.taskEvents)
            .set({ createdAt: microsecond(CYCLE_AT_MICRO) })
            .where(eq(schema.taskEvents.id, cycleEventId));
          const epoch = await retry();
          await db
            .update(schema.taskSteps)
            .set({ status: 'waiting_form' })
            .where(eq(schema.taskSteps.id, sourceId));
          await answerAsOwner(sourceId, taskId, microsecond(answerAt), 1);
          const result = await advance(epoch);
          expect(result.status).toBe(expected);
          if (expected === 'waiting_form') expect(apply).not.toHaveBeenCalled();
          else {
            expect(apply).toHaveBeenCalledOnce();
            expect(await advance(epoch)).toMatchObject({ status: 'done' });
            expect(apply).toHaveBeenCalledOnce();
          }
        },
      );

      it('an owner answer stamped with the old generation does not count for the re-run', async () => {
        const { taskId, sourceId, retry, advance, apply } = await seedRetriedCycle('above');
        const epoch = await retry();
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_form' })
          .where(eq(schema.taskSteps.id, sourceId));
        await answerAsOwner(sourceId, taskId, sql`now() + interval '1 second'`, 0);
        expectHeld(await advance(epoch), apply);
      });

      it('a later gate 3 commits with the preset once the re-run was answered and done', async () => {
        const { taskId, sourceId, retry, advance, apply } = await seedRetriedCycle('above');
        const epoch = await retry();
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_form' })
          .where(eq(schema.taskSteps.id, sourceId));
        await answerAsOwner(sourceId, taskId, sql`now() + interval '1 second'`, 1);
        expect(await advance(epoch)).toMatchObject({ status: 'done' });
        expect(apply).toHaveBeenCalledOnce();
        const later = await addGate3Row(taskId, 2, 'pending');
        await db
          .update(schema.tasks)
          .set({ currentStepId: gateId, currentRound: 2 })
          .where(eq(schema.tasks.id, taskId));
        const result = await advance(epoch, 2);
        expect(result.row.id).toBe(later.id);
        expect(result.status).toBe('done');
        expect(apply).toHaveBeenCalledTimes(2);
      });

      it('an unanswered re-run stays parked across Resume, boot re-entry and a second Retry', async () => {
        const { retry, advance, apply } = await seedRetriedCycle('above');
        let epoch = await retry();
        expectHeld(await advance(epoch), apply);
        for (const reentry of ['Resume', 'boot', 'Retry']) {
          if (reentry === 'Retry') epoch = await retry();
          expectHeld(await advance(epoch), apply, reentry);
        }
      });
    });

    describe('recovery', () => {
      it('an unanswered gate 3 stays parked across Resume, boot re-entry and Retry', async () => {
        const { ctx, params, apply } = await seedGate3('cycle');
        expectParked(await advanceStep(params), apply);
        for (const reentry of ['Resume', 'boot', 'Retry']) {
          let epoch = 0;
          if (reentry === 'Retry') {
            const reset = await resetStepAndDownstream(db, ctx.taskId, gateId, 1, 0);
            if (reset && reset !== 'superseded') epoch = reset.newEpoch;
          }
          const parked = await advanceStep({ ...params, epoch });
          expect(parked.status, reentry).toBe('waiting_form');
          expect(parked.row.waitingStartedAt, reentry).not.toBeNull();
          expect(apply, reentry).not.toHaveBeenCalled();
        }
      });

      it('an answered gate 3 is not parked again: apply runs once and a duplicate advance does nothing', async () => {
        const { ctx, params, apply } = await seedGate3('cycle', 1, CYCLE_AT);
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_form' })
          .where(eq(schema.taskSteps.id, ctx.taskStepId));
        await answerAsOwner(ctx.taskStepId, ctx.taskId);
        expect(await advanceStep(params)).toMatchObject({ status: 'done' });
        expect(apply).toHaveBeenCalledOnce();
        expect(await advanceStep(params)).toMatchObject({ status: 'done' });
        expect(apply).toHaveBeenCalledOnce();
      });
    });

    it.each(ANCHOR_CASES)(
      'after a clean cycle an answer %s needs to be newer than the cycle event to count',
      async (_name, answerAt, expected) => {
        const { ctx, params, apply } = await seedGate3('cycle', 1, microsecond(CYCLE_AT_MICRO));
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_form' })
          .where(eq(schema.taskSteps.id, ctx.taskStepId));
        await answerAsOwner(ctx.taskStepId, ctx.taskId, microsecond(answerAt));
        const result = await advanceStep(params);
        expect(result.status).toBe(expected);
        if (expected === 'waiting_form') expect(apply).not.toHaveBeenCalled();
        else expect(apply).toHaveBeenCalledOnce();
      },
    );

    it('after a failed verification gate 3 needs an answer newer than the gate-2 re-approval', async () => {
      const outcomes: Record<string, string> = {};
      for (const answerAt of ['2026-01-04T00:00:00Z', '2026-01-06T00:00:00Z']) {
        const { ctx, params, apply } = await seedGate3('cycle', 1, CYCLE_AT);
        await db.insert(schema.taskEvents).values([
          {
            taskId: ctx.taskId,
            eventType: 'insight.check',
            createdAt: new Date('2026-01-03T00:00:00Z'),
            payload: { version: 1, batchId: 'failed', kind: 'verify_failed', round: 1 },
          },
          {
            taskId: ctx.taskId,
            eventType: 'insight.check',
            createdAt: new Date('2026-01-05T00:00:00Z'),
            payload: { version: 1, batchId: 'failed', kind: 'gate2_approved', round: 1 },
          },
        ]);
        await db
          .update(schema.taskSteps)
          .set({ status: 'waiting_form' })
          .where(eq(schema.taskSteps.id, ctx.taskStepId));
        await answerAsOwner(ctx.taskStepId, ctx.taskId, new Date(answerAt));
        const result = await advanceStep(params);
        outcomes[answerAt] = result.status;
        if (result.status === 'waiting_form') expect(apply).not.toHaveBeenCalled();
        else expect(apply).toHaveBeenCalledOnce();
      }
      expect(outcomes).toEqual({
        '2026-01-04T00:00:00Z': 'waiting_form',
        '2026-01-06T00:00:00Z': 'done',
      });
    });

    describe('gate 2 kept for deferred QA findings', () => {
      const gate2Id = '09-gate-2-verify-approval';
      type Qa = { round: number; status: 'done' | 'skipped'; decision?: 'accept' | 'fix' };
      const QA_ACCEPT: Qa[] = [{ round: 2, status: 'done', decision: 'accept' }];

      async function addQaRow(taskId: string, qa: Qa) {
        await db.insert(schema.taskSteps).values({
          taskId,
          stepId: '08d2-adversarial-qa-review',
          stepIndex: 8.92,
          title: 'Adversarial QA review',
          status: qa.status,
          round: qa.round,
          output: qa.decision ? { decision: qa.decision } : {},
        });
      }

      function gate2Def() {
        const apply = vi.fn(async (_ctx, args) => ({ decision: args.formValues.decision }));
        const stepDef: StepDefinition = {
          metadata: {
            id: gate2Id,
            index: 9,
            workflowType: 'workflow',
            title: 'Gate 2',
            description: '',
            requiresCli: false,
          },
          form: () => ({
            title: 'Gate 2',
            fields: [
              {
                id: 'decision',
                type: 'radio',
                label: 'Decision',
                required: true,
                options: [
                  { value: 'approve', label: 'Approve' },
                  { value: 'reject', label: 'Reject' },
                ],
                default: 'reject',
              },
            ],
          }),
          apply,
        };
        return { apply, stepDef };
      }

      /** A pending gate-2 row at round 2 with a task pre-answer, in a cycle that began at round 1. */
      async function seedGate2(opts: { qa?: Qa[]; eventAt?: Date | SQL } = {}) {
        const { qa = QA_ACCEPT, eventAt = CYCLE_AT } = opts;
        const round = 2;
        const ctx = await seed();
        const [repo] = await db
          .insert(schema.repositories)
          .values({
            userId,
            name: 'gate 2 preset',
            source: 'blank',
            storagePath: '/unused',
            localPath: '/unused',
          })
          .returning();
        await db
          .update(schema.tasks)
          .set({
            type: 'workflow',
            repositoryId: repo!.id,
            currentStepId: gate2Id,
            currentRound: round,
            autoContinue: true,
            preAnswers: { [gate2Id]: { decision: 'approve' } },
          })
          .where(eq(schema.tasks.id, ctx.taskId));
        await db
          .update(schema.taskSteps)
          .set({
            stepId: gate2Id,
            stepIndex: 9,
            round,
            status: 'pending',
            detectOutput: {},
            formValues: null,
          })
          .where(eq(schema.taskSteps.id, ctx.taskStepId));
        const sourceRow = await addGate3Row(ctx.taskId, 0, 'done');
        await addContinuationEvent(ctx.taskId, sourceRow.id, 1, { createdAt: eventAt });
        for (const row of qa) await addQaRow(ctx.taskId, row);
        const { apply, stepDef } = gate2Def();
        const params = {
          db,
          taskId: ctx.taskId,
          userId,
          repoPath: '/unused',
          workspacePath: '/unused',
          cliProviderId: null,
          stepDef,
          epoch: 0,
          round,
          moduleDeactivation: null,
        };
        return { ctx, params, apply };
      }

      const expectGate2Parked = (
        result: Awaited<ReturnType<typeof advanceStep>>,
        apply: ReturnType<typeof vi.fn>,
        label?: string,
      ) => {
        expect(result.status, label).toBe('waiting_form');
        expect(result.row.waitingStartedAt, label).not.toBeNull();
        expect(result.row.formValues, label).toBeNull();
        expect(result.row.formSchema, label).toMatchObject({
          autoSubmit: false,
          fields: expect.arrayContaining([
            expect.objectContaining({ id: 'decision', default: 'reject' }),
          ]),
        });
        expect(apply, label).not.toHaveBeenCalled();
      };

      /** What the submit route writes in one transaction when the owner answers a gate-2 form. */
      async function answerGate2AsOwner(
        rowId: string,
        taskId: string,
        createdAt: Date | SQL = ANSWER_AT,
      ) {
        await db.transaction(async (tx) => {
          await tx
            .update(schema.taskSteps)
            .set({ formValues: { decision: 'approve' }, waitingStartedAt: null })
            .where(eq(schema.taskSteps.id, rowId));
          await tx.insert(schema.taskEvents).values({
            taskId,
            taskStepId: rowId,
            eventType: 'step.form_submitted',
            createdAt,
            payload: {
              stepId: gate2Id,
              fieldCount: 1,
              userId,
              generation: 0,
              decision: 'approve',
            },
          });
        });
      }

      it('parks after the real handoff chain left the task at gate 2', async () => {
        const { task, round } = await runInsightCheckWithQa([
          { status: 'done', round: 2, decision: 'accept' },
        ]);
        expect(task).toMatchObject({ currentStepId: gate2Id, currentRound: round });
        await db.insert(schema.taskSteps).values({
          taskId: task!.id,
          stepId: gate2Id,
          stepIndex: 9,
          title: 'Gate 2',
          status: 'pending',
          round,
          detectOutput: {},
        });
        await db
          .update(schema.tasks)
          .set({ autoContinue: true, preAnswers: { [gate2Id]: { decision: 'approve' } } })
          .where(eq(schema.tasks.id, task!.id));
        const { apply, stepDef } = gate2Def();
        const result = await advanceStep({
          db,
          taskId: task!.id,
          userId,
          repoPath: '/unused',
          workspacePath: '/unused',
          cliProviderId: null,
          stepDef,
          epoch: task!.orchestrationEpoch,
          round,
          moduleDeactivation: null,
        });
        expectGate2Parked(result, apply);
      });

      describe('recovery', () => {
        it('an unanswered gate 2 stays parked across Resume, boot re-entry and Retry', async () => {
          const { ctx, params, apply } = await seedGate2();
          expectGate2Parked(await advanceStep(params), apply);
          for (const reentry of ['Resume', 'boot', 'Retry']) {
            let epoch = 0;
            if (reentry === 'Retry') {
              const reset = await resetStepAndDownstream(db, ctx.taskId, gate2Id, 2, 0);
              if (reset && reset !== 'superseded') epoch = reset.newEpoch;
            }
            const parked = await advanceStep({ ...params, epoch });
            expect(parked.status, reentry).toBe('waiting_form');
            expect(parked.row.waitingStartedAt, reentry).not.toBeNull();
            expect(apply, reentry).not.toHaveBeenCalled();
          }
        });

        it('an answered gate 2 is not parked again: apply runs once and a duplicate advance does nothing', async () => {
          const { ctx, params, apply } = await seedGate2();
          await db
            .update(schema.taskSteps)
            .set({ status: 'waiting_form' })
            .where(eq(schema.taskSteps.id, ctx.taskStepId));
          await answerGate2AsOwner(ctx.taskStepId, ctx.taskId);
          expect(await advanceStep(params)).toMatchObject({ status: 'done' });
          expect(apply).toHaveBeenCalledOnce();
          expect(await advanceStep(params)).toMatchObject({ status: 'done' });
          expect(apply).toHaveBeenCalledOnce();
        });
      });

      it.each(ANCHOR_CASES)(
        'an answer %s needs to be newer than the cycle event to count',
        async (_name, answerAt, expected) => {
          const { ctx, params, apply } = await seedGate2({ eventAt: microsecond(CYCLE_AT_MICRO) });
          await db
            .update(schema.taskSteps)
            .set({ status: 'waiting_form' })
            .where(eq(schema.taskSteps.id, ctx.taskStepId));
          await answerGate2AsOwner(ctx.taskStepId, ctx.taskId, microsecond(answerAt));
          const result = await advanceStep(params);
          expect(result.status).toBe(expected);
          if (expected === 'waiting_form') expect(apply).not.toHaveBeenCalled();
          else expect(apply).toHaveBeenCalledOnce();
        },
      );

      it('after a failed verification inside the cycle, gate 2 needs an answer newer than the failure', async () => {
        const outcomes: Record<string, string> = {};
        for (const answerAt of ['2026-01-03T00:00:00Z', '2026-01-05T00:00:00Z']) {
          const { ctx, params, apply } = await seedGate2({ qa: [] });
          await db.insert(schema.taskEvents).values({
            taskId: ctx.taskId,
            eventType: 'insight.check',
            createdAt: new Date('2026-01-04T00:00:00Z'),
            payload: { version: 1, batchId: 'failed', kind: 'verify_failed', round: 2 },
          });
          await db
            .update(schema.taskSteps)
            .set({ status: 'waiting_form' })
            .where(eq(schema.taskSteps.id, ctx.taskStepId));
          await answerGate2AsOwner(ctx.taskStepId, ctx.taskId, new Date(answerAt));
          const result = await advanceStep(params);
          outcomes[answerAt] = result.status;
          if (result.status === 'waiting_form') expect(apply).not.toHaveBeenCalled();
          else expect(apply).toHaveBeenCalledOnce();
        }
        expect(outcomes).toEqual({
          '2026-01-03T00:00:00Z': 'waiting_form',
          '2026-01-05T00:00:00Z': 'done',
        });
      });
    });

    describe('after a re-approved failed verification', () => {
      const APPROVED_AT = '2026-01-02T00:00:00.000500Z';
      const ANSWER_CASES = [
        [
          '100 microseconds before the approval',
          '2026-01-02T00:00:00.000400Z',
          0,
          'owner',
          'waiting_form',
        ],
        ['100 microseconds after the approval', '2026-01-02T00:00:00.000600Z', 0, 'owner', 'done'],
        ['by another user', '2026-01-02T00:00:00.000600Z', 0, 'other', 'waiting_form'],
        ['for another generation', '2026-01-02T00:00:00.000600Z', 1, 'owner', 'waiting_form'],
      ] as const;

      async function addCheck(
        taskId: string,
        kind: 'verify_failed' | 'gate2_approved',
        round: number,
        createdAt: string,
      ) {
        await db.insert(schema.taskEvents).values({
          taskId,
          eventType: 'insight.check',
          createdAt: microsecond(createdAt),
          payload: { version: 1, batchId: 'failed', kind, round },
        });
      }

      /** A gate-3 row a Retry pulled back to round 2, below the gate-2 approval's round 3. */
      async function seedPulledBack(check: 'approved' | 'failed' | 'none' = 'approved') {
        const seeded = await seedGate3('none', 2);
        if (check === 'approved')
          await addCheck(seeded.ctx.taskId, 'gate2_approved', 3, APPROVED_AT);
        if (check === 'failed') await addCheck(seeded.ctx.taskId, 'verify_failed', 3, APPROVED_AT);
        const retry = async () => {
          const reset = await resetStepAndDownstream(db, seeded.ctx.taskId, gateId, 2);
          if (!reset || reset === 'superseded') throw new Error('the reset did not apply');
          return reset.newEpoch;
        };
        const waitForAnswer = () =>
          db
            .update(schema.taskSteps)
            .set({ status: 'waiting_form' })
            .where(eq(schema.taskSteps.id, seeded.ctx.taskStepId));
        return { ...seeded, retry, waitForAnswer };
      }

      it('parks a pulled-back gate 3 even with a preset', async () => {
        const { params, apply } = await seedPulledBack();
        expectParked(await advanceStep(params), apply);
      });

      it.each(ANSWER_CASES)(
        'an owner answer %s',
        async (_name, answerAt, generation, answeredBy, expected) => {
          const { ctx, params, apply, waitForAnswer } = await seedPulledBack();
          await waitForAnswer();
          await answerAsOwner(
            ctx.taskStepId,
            ctx.taskId,
            microsecond(answerAt),
            generation,
            answeredBy === 'owner' ? userId : randomUUID(),
          );
          expect((await advanceStep(params)).status).toBe(expected);
          if (expected === 'waiting_form') expect(apply).not.toHaveBeenCalled();
          else {
            expect(apply).toHaveBeenCalledOnce();
            expect(await advanceStep(params)).toMatchObject({ status: 'done' });
            expect(apply).toHaveBeenCalledOnce();
          }
        },
      );

      it.each([
        [
          "is the owner's answer after the approval",
          '2026-01-02T00:00:00.000600Z',
          'owner',
          0,
          'form_submitted',
          'gate3',
          'done',
        ],
        [
          "is the owner's answer before the approval",
          '2026-01-02T00:00:00.000400Z',
          'owner',
          0,
          'form_submitted',
          'gate3',
          'waiting_form',
        ],
        [
          'is by another user',
          '2026-01-02T00:00:00.000600Z',
          'other',
          0,
          'form_submitted',
          'gate3',
          'waiting_form',
        ],
        [
          'is stamped for another generation',
          '2026-01-02T00:00:00.000600Z',
          'owner',
          1,
          'form_submitted',
          'gate3',
          'waiting_form',
        ],
        [
          'is an event of another type',
          '2026-01-02T00:00:00.000600Z',
          'owner',
          0,
          'skip',
          'gate3',
          'waiting_form',
        ],
        [
          'sits on a gate-2 row',
          '2026-01-02T00:00:00.000600Z',
          'owner',
          0,
          'form_submitted',
          'gate2',
          'waiting_form',
        ],
      ] as const)(
        'a later gate 3 settles only on a proof row that %s',
        async (_name, at, who, generation, kind, onRow, expected) => {
          const { ctx, params, apply, sourceRow } = await seedGate3('none', 4);
          await addCheck(ctx.taskId, 'gate2_approved', 3, APPROVED_AT);
          let rowId = sourceRow.id;
          if (onRow === 'gate2') {
            const [gate2] = await db
              .insert(schema.taskSteps)
              .values({
                taskId: ctx.taskId,
                stepId: '09-gate-2-verify-approval',
                stepIndex: 9,
                title: 'Verify approval',
                status: 'done',
                round: 3,
                formValues: { commit: true },
                output: {},
              })
              .returning();
            rowId = gate2!.id;
          }
          await db.insert(schema.taskEvents).values({
            taskId: ctx.taskId,
            taskStepId: rowId,
            eventType: kind === 'skip' ? 'step.skip' : 'step.form_submitted',
            createdAt: microsecond(at),
            payload: {
              stepId: gateId,
              fieldCount: 1,
              userId: who === 'owner' ? userId : randomUUID(),
              generation,
              commit: true,
            },
          });
          const result = await advanceStep(params);
          if (expected === 'done') {
            expect(result.status).toBe('done');
            expect(apply).toHaveBeenCalledOnce();
          } else expectParked(result, apply);
        },
      );

      it('a later gate 3 commits with the preset until a newer approval latches it again', async () => {
        const { ctx, params, apply, waitForAnswer } = await seedPulledBack();
        await waitForAnswer();
        await answerAsOwner(ctx.taskStepId, ctx.taskId, microsecond('2026-01-02T00:00:00.000600Z'));
        expect(await advanceStep(params)).toMatchObject({ status: 'done' });
        expect(apply).toHaveBeenCalledOnce();
        const later = await addGate3Row(ctx.taskId, 4, 'pending');
        await db
          .update(schema.tasks)
          .set({ currentStepId: gateId, currentRound: 4 })
          .where(eq(schema.tasks.id, ctx.taskId));
        const committed = await advanceStep({ ...params, round: 4 });
        expect(committed.row.id).toBe(later.id);
        expect(committed.status).toBe('done');
        expect(apply).toHaveBeenCalledTimes(2);
        await addCheck(ctx.taskId, 'gate2_approved', 5, '2026-01-02T00:00:01Z');
        const next = await addGate3Row(ctx.taskId, 6, 'pending');
        await db
          .update(schema.tasks)
          .set({ currentStepId: gateId, currentRound: 6 })
          .where(eq(schema.tasks.id, ctx.taskId));
        const parked = await advanceStep({ ...params, round: 6 });
        expect(parked.row.id).toBe(next.id);
        expect(parked.status).toBe('waiting_form');
        expect(apply).toHaveBeenCalledTimes(2);
      });

      it('a Retry of the answered row asks again', async () => {
        const { ctx, params, apply, waitForAnswer, retry } = await seedPulledBack();
        await waitForAnswer();
        await answerAsOwner(ctx.taskStepId, ctx.taskId, microsecond('2026-01-02T00:00:00.000600Z'));
        expect(await advanceStep(params)).toMatchObject({ status: 'done' });
        expect(apply).toHaveBeenCalledOnce();
        apply.mockClear();
        const epoch = await retry();
        expectParked(await advanceStep({ ...params, epoch }), apply, 'after the Retry');
      });

      it('an unanswered pulled-back row stays parked across Resume, boot re-entry and a second Retry', async () => {
        const { params, apply, retry } = await seedPulledBack();
        let epoch = params.epoch;
        for (const reentry of ['first', 'Resume', 'boot', 'Retry']) {
          if (reentry === 'Retry') epoch = await retry();
          const parked = await advanceStep({ ...params, epoch });
          expect(parked.status, reentry).toBe('waiting_form');
          expect(parked.row.waitingStartedAt, reentry).not.toBeNull();
          expect(apply, reentry).not.toHaveBeenCalled();
        }
      });

      it.each(['none', 'failed'] as const)(
        'a pulled-back row commits with the preset when the check state is %s',
        async (check) => {
          const { params, apply } = await seedPulledBack(check);
          expect(await advanceStep(params)).toMatchObject({ status: 'done' });
          expect(apply).toHaveBeenCalledOnce();
        },
      );
    });
  });
  it('PR5 gate pick is consumed once, resets the pending gate, and only then runs an editor', async () => {
    const { ctx, source, continuation } = await seedGatePick();
    const routes = await Promise.all([
      handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
      handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
    ]);
    expect(routes.filter(Boolean)).toHaveLength(1);
    expect(routes.find(Boolean)).toMatchObject({
      next: { metadata: { id: '08e-insights-triage' } },
      round: 1,
    });
    expect(await activeInsightContinuation(db, ctx.taskId, 1)).toEqual(continuation);
    const gate = await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, ctx.taskId),
        eq(schema.taskSteps.stepId, '10-gate-3-commit'),
        eq(schema.taskSteps.round, 1),
      ),
    });
    expect(gate).toMatchObject({
      status: 'pending',
      output: null,
      formSchema: null,
      detectOutput: null,
    });
  });
  it.each(['Stop', 'dead', 'Cancel', 'epoch', 'owner', 'Retry', 'pause'])(
    'PR5 gate pick boundary respects %s',
    async (kind) => {
      const { ctx, source, continuation } = await seedGatePick();
      if (kind === 'Retry')
        await db
          .update(schema.taskSteps)
          .set({ status: 'pending', rerunGeneration: 1 })
          .where(eq(schema.taskSteps.id, source.id));
      else if (kind === 'owner') ctx.userId = randomUUID();
      else
        await db
          .update(schema.tasks)
          .set(
            kind === 'Stop'
              ? { status: 'failed' }
              : kind === 'Cancel'
                ? { status: 'cancelled' }
                : kind === 'dead'
                  ? { deadAt: new Date() }
                  : kind === 'epoch'
                    ? { orchestrationEpoch: 1 }
                    : { pausedAt: new Date() },
          )
          .where(eq(schema.tasks.id, ctx.taskId));
      const result = await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
      expect(Boolean(result)).toBe(kind === 'pause');
    },
  );
  const routeEvents = (taskId: string) =>
    db.query.taskEvents.findMany({
      where: and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, 'insight.continuation'),
      ),
    });
  it('recovers a lost done-row handoff, deduplicates delivery and resets stale check rows atomically', async () => {
    const { ctx, source, continuation } = await seedRoute(true);
    const verdict = await finishedStepResult(db, ctx.taskId, insightsTriageStep, source);
    expect(verdict).toMatchObject({ status: 'revise', continuation });
    const routes = await Promise.all([
      handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
      handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
    ]);
    expect(routes.filter(Boolean)).toHaveLength(1);
    expect(await routeEvents(ctx.taskId)).toHaveLength(1);
    const rows = await db.query.taskSteps.findMany({
      where: and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.round, 1)),
    });
    expect(
      rows.every((r) => r.status === 'pending' && r.output === null && r.rerunGeneration === 1),
    ).toBe(true);
    const events = await db.query.taskEvents.findMany({
      where: eq(schema.taskEvents.taskId, ctx.taskId),
    });
    expect(events.some((e) => e.eventType === 'fix_loop.started')).toBe(false);
    expect(events.filter((e) => e.eventType === 'step.revise')).toMatchObject([
      {
        taskStepId: source.id,
        payload: {
          continuation,
          sourceStepId: source.stepId,
          targetStepId: '08-phase-5-verify',
          round: 1,
        },
      },
    ]);
    expect(await activeInsightContinuation(db, ctx.taskId, 1)).toEqual(continuation);
  });
  it.each(['done', 'skipped', 'pending', 'failed', null] as const)(
    'uses the earliest checkpoint (%s) even after a later round row exists',
    async (status) => {
      const { ctx, source, continuation } = await seedRoute();
      await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
      if (status)
        await db.insert(schema.taskSteps).values({
          taskId: ctx.taskId,
          stepId: source.stepId,
          stepIndex: 8.95,
          title: 'Checkpoint',
          status,
          round: 1,
        });
      await db.insert(schema.taskSteps).values({
        taskId: ctx.taskId,
        stepId: source.stepId,
        stepIndex: 8.95,
        title: 'Later manual triage',
        status: 'pending',
        round: 2,
      });
      expect(await activeInsightContinuation(db, ctx.taskId, 2)).toEqual(
        status === 'done' || status === 'skipped' ? null : continuation,
      );
      if (status === 'done') {
        // The gate-2 rejection forks a later implementation round after the checkpoint settled.
        await db.insert(schema.taskEvents).values({
          taskId: ctx.taskId,
          eventType: 'fix_loop.requested',
          payload: { sourceStepId: '09-gate-2-verify-approval', round: 2, diagnosis: 'Revise' },
        });
        await db.insert(schema.cliInvocations).values({
          taskId: ctx.taskId,
          taskStepId: source.id,
          mode: 'cli',
          prompt: 'review',
          rawOutput: '## INSIGHTS\n- INSIGHT: New optional improvement | new.ts | Detail',
        });
        const spec = vi
          .spyOn(specArtifacts, 'resolveSpecView')
          .mockResolvedValue({ text: '' } as never);
        try {
          const stepCtx = {
            db,
            taskId: ctx.taskId,
            round: 2,
            workspacePath: '/repo',
            sandboxWorkdir: '/ws',
            throwIfCancelled() {},
          } as StepContext;
          expect(await insightsTriageStep.shouldRun!(stepCtx)).toBe(true);
          const detected = await insightsTriageStep.detect!(stepCtx);
          expect(detected.insightCheckpoint).toBeUndefined();
          const form = await insightsTriageStep.form!(stepCtx, detected, null);
          expect(form!.autoSubmit).not.toBe(true);
          expect(form!.fields).toMatchObject([
            { id: 'selectedInsights', options: [{ label: 'New optional improvement (new.ts)' }] },
          ]);
        } finally {
          spec.mockRestore();
        }
      }
    },
  );
  it('settles the owned checkpoint after verification Retry abandons an earlier pending checkpoint', async () => {
    const { ctx, source, continuation } = await seedRoute();
    await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
    const [verify] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: ctx.taskId,
        stepId: '08-phase-5-verify',
        stepIndex: 8,
        runSeq: 2,
        title: 'Verify',
        status: 'done',
        round: 1,
      })
      .returning();
    const settleCheckpoint = async (round: number, epoch: number) => {
      const result = await advanceStep({
        db,
        taskId: ctx.taskId,
        userId,
        stepDef: insightsTriageStep,
        repoPath: '/repo',
        workspacePath: '/repo',
        cliProviderId: null,
        round,
        epoch,
        runSeq: 4,
        moduleDeactivation: null,
      });
      expect(result.status).toBe('done');
      expect(result.row.output).toMatchObject({ batchId: continuation.batchId, items: [] });
      return result.row;
    };
    await settleCheckpoint(1, 0);
    expect(await activeInsightContinuation(db, ctx.taskId, 1)).toBeNull();
    // Retry verification while gate 2 waits: the checkpoint reopens in the same round.
    await db
      .update(schema.tasks)
      .set({ currentStepId: '09-gate-2-verify-approval' })
      .where(eq(schema.tasks.id, ctx.taskId));
    expect(await resetStepAndDownstream(db, ctx.taskId, verify!.stepId, 1, 0)).toMatchObject({
      newEpoch: 1,
    });
    expect(await activeInsightContinuation(db, ctx.taskId, 1)).toEqual(continuation);
    // Verification starts a fix round. Its forward walk never revisits round 1.
    await db.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      eventType: 'fix_loop.started',
      payload: { sourceStepId: verify!.stepId, round: 2 },
    });
    const owned = await settleCheckpoint(2, 1);
    expect(
      await db.query.taskSteps.findFirst({
        where: and(
          eq(schema.taskSteps.taskId, ctx.taskId),
          eq(schema.taskSteps.stepId, source.stepId),
          eq(schema.taskSteps.round, 1),
        ),
      }),
    ).toMatchObject({ status: 'pending', rerunGeneration: 1 });
    expect(await activeInsightContinuation(db, ctx.taskId, 2)).toBeNull();
    // A later gate-2 reject must offer new insights, not another empty checkpoint.
    await db.insert(schema.taskEvents).values({
      taskId: ctx.taskId,
      eventType: 'fix_loop.requested',
      payload: { sourceStepId: '09-gate-2-verify-approval', round: 3 },
    });
    await db.insert(schema.cliInvocations).values({
      taskId: ctx.taskId,
      taskStepId: source.id,
      mode: 'cli',
      prompt: 'review',
      rawOutput: '## INSIGHTS\n- INSIGHT: Fresh improvement | fresh.ts | Detail',
    });
    const spec = vi
      .spyOn(specArtifacts, 'resolveSpecView')
      .mockResolvedValue({ text: '' } as never);
    try {
      const laterCtx = { db, taskId: ctx.taskId, round: 3, throwIfCancelled() {} } as StepContext;
      const detected = await insightsTriageStep.detect!(laterCtx);
      expect(detected.insightCheckpoint).toBeUndefined();
      expect(insightsTriageStep.form!(laterCtx, detected, null)).toMatchObject({
        fields: [{ id: 'selectedInsights', options: [{ label: 'Fresh improvement (fresh.ts)' }] }],
      });
    } finally {
      spec.mockRestore();
    }
    // Retry of the actual owned checkpoint still reopens that continuation.
    expect(await resetStepAndDownstream(db, ctx.taskId, owned.stepId, 2, 1)).toMatchObject({
      newEpoch: 2,
    });
    expect(await activeInsightContinuation(db, ctx.taskId, 2)).toEqual(continuation);
  });
  it('an automatic settled checkpoint owns the continuation after an earlier row is abandoned', async () => {
    const { ctx, source, continuation } = await seedRoute(false, true);
    await db
      .update(schema.tasks)
      .set({ autoActOnInsights: true })
      .where(eq(schema.tasks.id, ctx.taskId));
    await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
    await db.insert(schema.taskSteps).values({
      taskId: ctx.taskId,
      stepId: source.stepId,
      stepIndex: 8.95,
      title: 'Abandoned checkpoint',
      status: 'pending',
      round: 1,
    });
    await db
      .update(schema.tasks)
      .set({ currentStepId: source.stepId, currentRound: 2 })
      .where(eq(schema.tasks.id, ctx.taskId));
    const spec = vi
      .spyOn(specArtifacts, 'resolveSpecView')
      .mockResolvedValue({ text: '' } as never);
    try {
      const result = await advanceStep({
        db,
        taskId: ctx.taskId,
        userId,
        stepDef: insightsTriageStep,
        repoPath: '/repo',
        workspacePath: '/repo',
        cliProviderId: null,
        round: 2,
        epoch: 0,
        runSeq: 4,
        moduleDeactivation: null,
      });
      expect(result.status).toBe('done');
      expect(result.row.output).toMatchObject({
        insightCheckpoint: continuation,
        automatic: { stopReason: 'no_new_consequential' },
      });
      expect((await routeEvents(ctx.taskId))[0]?.payload).toMatchObject({
        checkpoint: { stepRowId: result.row.id, round: 2, generation: 0 },
      });
      expect(await activeInsightContinuation(db, ctx.taskId, 2)).toBeNull();
    } finally {
      spec.mockRestore();
    }
  });
  it('rolls checkpoint publication back if its required ownership write fails', async () => {
    const { ctx, source, continuation } = await seedRoute();
    await handoffInsightContinuation(db, ctx, source, continuation, routeSteps);
    const [checkpoint] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: ctx.taskId,
        stepId: source.stepId,
        stepIndex: 8.95,
        title: 'Checkpoint',
        status: 'running',
        round: 1,
      })
      .returning();
    await db.execute(
      sql.raw(`ALTER TABLE task_events ADD CONSTRAINT insight_checkpoint_test
      CHECK (task_id <> '${ctx.taskId}'::uuid OR NOT (payload ? 'checkpoint'))`),
    );
    try {
      await expect(
        publishInsightStep(
          {
            db,
            taskId: ctx.taskId,
            taskStepId: checkpoint!.id,
            userId,
            epoch: 0,
            rerunGeneration: 0,
            throwIfCancelled() {},
          } as StepContext,
          { status: 'done', output: { insightCheckpoint: continuation } },
        ),
      ).rejects.toThrow();
      expect(
        await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, checkpoint!.id) }),
      ).toMatchObject({ status: 'running', output: null });
      expect((await routeEvents(ctx.taskId))[0]?.payload).not.toHaveProperty('checkpoint');
    } finally {
      await db.execute(sql`ALTER TABLE task_events DROP CONSTRAINT insight_checkpoint_test`);
    }
  });
  it('boot epoch recovery preserves the batch, and downstream Retry retains the active route', async () => {
    const { ctx, source, continuation } = await seedRoute();
    await db
      .update(schema.tasks)
      .set({ orchestrationEpoch: 1 })
      .where(eq(schema.tasks.id, ctx.taskId));
    expect(
      await handoffInsightContinuation(
        db,
        { ...ctx, orchestrationEpoch: 1 },
        source,
        continuation,
        routeSteps,
      ),
    ).toMatchObject({ round: 1, epoch: 1 });
    const [verify] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: ctx.taskId,
        stepId: '08-phase-5-verify',
        stepIndex: 8,
        title: 'Verify',
        status: 'failed',
        round: 1,
      })
      .returning();
    expect(await resetStepAndDownstream(db, ctx.taskId, verify!.stepId, 1, 1)).toMatchObject({
      newEpoch: 2,
    });
    expect(await activeInsightContinuation(db, ctx.taskId, 1)).toEqual(continuation);
  });
  it.each(['insight.continuation', 'step.revise'])(
    '%s event-write failure rolls back the pointer, reset, and epoch bump',
    async (eventType) => {
      const { ctx, source, continuation } = await seedRoute(true);
      await db.execute(
        sql.raw(
          `ALTER TABLE task_events ADD CONSTRAINT insight_route_test CHECK (task_id <> '${ctx.taskId}'::uuid OR event_type <> '${eventType}')`,
        ),
      );
      try {
        await expect(
          handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
        ).rejects.toMatchObject({ cause: { code: '23514' } });
        expect(
          await db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) }),
        ).toMatchObject({ orchestrationEpoch: 0, currentRound: 0, currentStepId: source.stepId });
        expect(
          (
            await db.query.taskSteps.findMany({
              where: and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.round, 1)),
            })
          ).every((r) => r.status === 'done' && r.rerunGeneration === 0),
        ).toBe(true);
        expect(await routeEvents(ctx.taskId)).toHaveLength(0);
        expect(
          await db.query.taskEvents.findMany({
            where: and(
              eq(schema.taskEvents.taskId, ctx.taskId),
              eq(schema.taskEvents.eventType, 'step.revise'),
            ),
          }),
        ).toHaveLength(0);
      } finally {
        await db.execute(sql`ALTER TABLE task_events DROP CONSTRAINT insight_route_test`);
      }
      expect(
        await handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
      ).not.toBeNull();
    },
  );
  it.each(['Stop', 'dead', 'Cancel', 'epoch', 'owner', 'Retry'])(
    'refuses %s arriving during snapshot await without a route or stale-row reset',
    async (kind) => {
      const { ctx, source, continuation } = await seedRoute(true);
      await db.insert(schema.taskSteps).values({
        taskId: ctx.taskId,
        stepId: '07b-phase-4-validate',
        stepIndex: 7.9,
        title: 'Validate',
        status: 'done',
        round: 0,
        output: { validationSnapshot: { 'a.ts': 'before' } },
      });
      const snapshot = vi
        .spyOn(validationSnapshots, 'readValidationSnapshot')
        .mockImplementationOnce(async () => {
          if (kind === 'Retry')
            await db
              .update(schema.taskSteps)
              .set({ rerunGeneration: 1, status: 'pending', output: null })
              .where(eq(schema.taskSteps.id, source.id));
          else if (kind === 'owner') ctx.userId = randomUUID();
          else
            await db
              .update(schema.tasks)
              .set(
                kind === 'Stop'
                  ? { status: 'failed' }
                  : kind === 'Cancel'
                    ? { status: 'cancelled' }
                    : kind === 'dead'
                      ? { deadAt: new Date() }
                      : kind === 'epoch'
                        ? { orchestrationEpoch: 1 }
                        : { userId: randomUUID() },
              )
              .where(eq(schema.tasks.id, ctx.taskId));
          return { 'a.ts': 'before' };
        });
      try {
        expect(
          await handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
        ).toBeNull();
        expect(await routeEvents(ctx.taskId)).toHaveLength(0);
        expect(
          (
            await db.query.taskSteps.findMany({
              where: and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.round, 1)),
            })
          ).every((r) => r.status === 'done'),
        ).toBe(true);
      } finally {
        snapshot.mockRestore();
      }
    },
  );
  it('pause allows the owned handoff; new work still meets the ordinary fresh-step pause gate', async () => {
    const { ctx, source, continuation } = await seedRoute();
    await db
      .update(schema.tasks)
      .set({ pausedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    expect(
      await handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
    ).not.toBeNull();
    expect(
      await db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) }),
    ).toMatchObject({ currentStepId: '08-phase-5-verify' });
  });
  it('a moved tree records validation first and its verification return address', async () => {
    const { ctx, source, continuation } = await seedRoute(true);
    await db.insert(schema.taskSteps).values({
      taskId: ctx.taskId,
      stepId: '07b-phase-4-validate',
      stepIndex: 7.9,
      title: 'Validate',
      status: 'done',
      round: 0,
      output: { validationSnapshot: { 'a.ts': 'before' } },
    });
    const snapshot = vi
      .spyOn(validationSnapshots, 'readValidationSnapshot')
      .mockResolvedValue({ 'a.ts': 'after' });
    try {
      expect(
        await handoffInsightContinuation(db, ctx, source, continuation, routeSteps),
      ).toMatchObject({ next: { metadata: { id: '07c-ddev-reconcile' } }, round: 1 });
      const stale = await db.query.taskSteps.findMany({
        where: and(eq(schema.taskSteps.taskId, ctx.taskId), eq(schema.taskSteps.round, 1)),
      });
      expect(stale.every((row) => row.status === 'pending' && row.output === null)).toBe(true);
      expect(
        await db.query.taskEvents.findFirst({
          where: and(
            eq(schema.taskEvents.taskId, ctx.taskId),
            eq(schema.taskEvents.eventType, 'validation.recheck_requested'),
          ),
        }),
      ).toMatchObject({ payload: { resumeStepId: '08-phase-5-verify', round: 1 } });
    } finally {
      snapshot.mockRestore();
    }
  });
  it('missing review destination refuses before any reset', async () => {
    const { ctx, source, continuation } = await seedRoute(true);
    await expect(
      handoffInsightContinuation(
        db,
        ctx,
        source,
        continuation,
        routeSteps.filter((s) => s.metadata.id !== '08c-code-review'),
      ),
    ).rejects.toThrow(/run list/);
    expect(await routeEvents(ctx.taskId)).toHaveLength(0);
    expect(
      (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, ctx.taskId) }))
        ?.orchestrationEpoch,
    ).toBe(0);
  });
  it.each(['Stop', 'dead', 'Cancel', 'epoch', 'owner', 'Retry'])(
    'the done publication refuses %s at the same fence as the journal',
    async (kind) => {
      const ctx = await seed();
      if (kind === 'Retry')
        await db
          .update(schema.taskSteps)
          .set({ rerunGeneration: 1 })
          .where(eq(schema.taskSteps.id, ctx.taskStepId));
      else if (kind === 'owner') ctx.userId = randomUUID();
      else
        await db
          .update(schema.tasks)
          .set(
            kind === 'Stop'
              ? { status: 'failed' }
              : kind === 'Cancel'
                ? { status: 'cancelled' }
                : kind === 'dead'
                  ? { deadAt: new Date() }
                  : { orchestrationEpoch: 1 },
          )
          .where(eq(schema.tasks.id, ctx.taskId));
      await expect(
        publishInsightStep(ctx, { status: 'done', output: { continuation: {} } }),
      ).rejects.toMatchObject({ name: 'StepSupersededError' });
      expect(
        await db.query.taskSteps.findFirst({ where: eq(schema.taskSteps.id, ctx.taskStepId) }),
      ).toMatchObject({ status: 'running', output: null });
    },
  );
  it('done publication retains generation under pause and persists the exact verdict', async () => {
    const ctx = await seed();
    await db
      .update(schema.tasks)
      .set({ pausedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    const continuation = {
      version: 1,
      kind: 'insight_revise',
      batchId: 'batch',
      sourceStepRow: ctx.taskStepId,
      generation: 0,
      round: 1,
    };
    expect(
      await publishInsightStep(ctx, { status: 'done', output: { continuation } }),
    ).toMatchObject({ status: 'done', rerunGeneration: 0, output: { continuation } });
  });
});

describe.skipIf(!url)('automatic insight admission on PostgreSQL', () => {
  let db: Database;
  const userId = randomUUID();
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });
  const insight = (name: string) => ({
    id: name,
    identity: `a.ts::${name}`,
    legacyId: name,
    picked: false,
    sourceStep: 'review',
    title: name,
    location: 'a.ts',
    description: 'detail',
  });
  async function seed() {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'workflow',
        title: 'auto',
        status: 'running',
        autoActOnInsights: true,
        currentStepId: '08e-insights-triage',
        currentRound: 0,
      })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '08e-insights-triage',
        stepIndex: 8.95,
        title: 'Insights',
        status: 'running',
        round: 0,
      })
      .returning();
    return {
      db,
      taskId: task!.id,
      taskStepId: step!.id,
      userId,
      round: 0,
      epoch: 0,
      rerunGeneration: 0,
      throwIfCancelled() {},
    } as StepContext;
  }
  it('serializes duplicate advances, preserves a pre-reservation claim at boot and rolls back a refused event', async () => {
    const ctx = await seed();
    const [a, b] = await Promise.all([
      claimAutoRound(ctx, [insight('one')]),
      claimAutoRound(ctx, [insight('one')]),
    ]);
    expect(a).toEqual(b);
    expect((await loadAutoHistory(db, ctx.taskId)).claims).toHaveLength(1);
    expect(await hasCliWork(db, ctx.taskStepId, 0, '08e-insights-triage')).toBe(true);
    const other = await seed();
    await db.execute(
      sql.raw(
        `ALTER TABLE task_events ADD CONSTRAINT ins4_reject CHECK (task_id <> '${other.taskId}'::uuid OR event_type <> 'insight.auto_round_started')`,
      ),
    );
    try {
      await expect(claimAutoRound(other, [insight('one')])).rejects.toMatchObject({
        cause: { code: '23514' },
      });
    } finally {
      await db.execute(sql`ALTER TABLE task_events DROP CONSTRAINT ins4_reject`);
    }
    expect((await loadAutoHistory(db, other.taskId)).claims).toEqual([]);
  });
  it('survives Retry, Resume, done replay and epoch takeover, with an injectable cap', async () => {
    let ctx = await seed();
    const first = await claimAutoRound(ctx, [insight('one')], { rounds: 2 });
    await db
      .update(schema.tasks)
      .set({ orchestrationEpoch: 1 })
      .where(eq(schema.tasks.id, ctx.taskId));
    ctx = { ...ctx, epoch: 1 };
    expect(await claimAutoRound(ctx, [insight('one')], { rounds: 2 })).toEqual(first);
    await db
      .update(schema.taskSteps)
      .set({ status: 'done' })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    expect(await claimAutoRound(ctx, [insight('one')], { rounds: 2 })).toEqual(first);
    const reset = await resetStepAndDownstream(db, ctx.taskId, '08e-insights-triage', 0, 1);
    if (!reset || reset === 'superseded') throw new Error('reset overtaken');
    ctx = { ...ctx, epoch: reset.newEpoch, rerunGeneration: 1 };
    await db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    expect(await claimAutoRound(ctx, [insight('one')], { rounds: 2 })).toBeNull();
    const second = await claimAutoRound(ctx, [insight('two')], { rounds: 2 });
    expect(second?.ordinal).toBe(2);
    const reset2 = await resetStepAndDownstream(
      db,
      ctx.taskId,
      '08e-insights-triage',
      0,
      ctx.epoch!,
    );
    if (!reset2 || reset2 === 'superseded') throw new Error('reset overtaken');
    ctx = { ...ctx, epoch: reset2.newEpoch, rerunGeneration: 2 };
    await db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    expect(await claimAutoRound(ctx, [insight('three')], { rounds: 2 })).toBeNull();
    expect((await loadAutoHistory(db, ctx.taskId)).claims).toHaveLength(2);
  });
  it.each(['OFF', 'pause', 'Stop', 'Cancel', 'dead', 'owner', 'epoch', 'pointer'] as const)(
    'refuses new work under %s',
    async (kind) => {
      const ctx = await seed();
      const patch =
        kind === 'OFF'
          ? { autoActOnInsights: false }
          : kind === 'pause'
            ? { pausedAt: new Date() }
            : kind === 'Stop'
              ? { status: 'failed' as const }
              : kind === 'Cancel'
                ? { status: 'cancelled' as const }
                : kind === 'dead'
                  ? { deadAt: new Date() }
                  : kind === 'epoch'
                    ? { orchestrationEpoch: 1 }
                    : kind === 'pointer'
                      ? { currentStepId: 'other' }
                      : {};
      await db
        .update(schema.tasks)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.tasks.id, ctx.taskId));
      if (kind === 'owner') ctx.userId = randomUUID();
      if (kind === 'OFF') expect(await claimAutoRound(ctx, [insight('one')])).toBeNull();
      else
        await expect(claimAutoRound(ctx, [insight('one')])).rejects.toMatchObject({
          name: 'StepSupersededError',
        });
      expect((await loadAutoHistory(db, ctx.taskId)).claims).toEqual([]);
    },
  );
  it('pause between detection and claim holds without spending or downgrading the cohort', async () => {
    const ctx = await seed();
    const state = {
      version: 1 as const,
      mode: 'classify' as const,
      candidates: [insight('one')],
      roundsStarted: 0,
      decisions: [],
      stopReason: 'classifying' as const,
    };
    await db
      .update(schema.tasks)
      .set({ pausedAt: new Date() })
      .where(eq(schema.tasks.id, ctx.taskId));
    await expect(startAutoClassification(ctx, state)).rejects.toMatchObject({
      name: 'StepSupersededError',
    });
    expect(await loadAutoHistory(db, ctx.taskId)).toEqual({ claims: [], results: [] });
    await db.update(schema.tasks).set({ pausedAt: null }).where(eq(schema.tasks.id, ctx.taskId));
    expect(await startAutoClassification(ctx, state)).toMatchObject([{ roleKey: 'triage' }]);
    expect(await loadAutoHistory(db, ctx.taskId)).toMatchObject({
      claims: [{ ordinal: 1 }],
      results: [],
    });
  });
  it('an over-budget real batch id refuses before the claim commits', async () => {
    const ctx = await seed();
    const chosen = [insight('one')];
    const realSize = buildClassifierPrompt(
      chosen,
      undefined,
      insightBatchId(ctx.taskStepId, 0),
    ).length;
    await expect(claimAutoRound(ctx, chosen, { inputChars: realSize - 1 })).rejects.toThrow(
      /budget/,
    );
    expect(await loadAutoHistory(db, ctx.taskId)).toEqual({ claims: [], results: [] });
  });
  it('reads a claim after the loader adds an unrelated input field', async () => {
    const ctx = await seed();
    const chosen = { ...insight('one'), futureLoaderField: { provenance: 'new' } };
    await claimAutoRound(ctx, [chosen]);
    const history = await loadAutoHistory(db, ctx.taskId);
    expect(history.claims).toHaveLength(1);
    expect(history.claims[0]?.insights).toEqual([insight('one')]);
  });
  it('publishes classification once before any editor and refuses an overtaken generation', async () => {
    const ctx = await seed();
    const claim = (await claimAutoRound(ctx, [insight('one')]))!;
    const record = {
      version: 1 as const,
      batchId: claim.batchId,
      sourceStepRowId: ctx.taskStepId,
      generation: 0,
      complete: true,
      items: [
        {
          id: 'one',
          identity: 'a.ts::one',
          class: 'nit' as const,
          kind: 'correctness' as const,
          eligible: true,
          outcome: 'left_minor' as const,
          reason: 'style',
        },
      ],
      invocationIds: [],
    };
    await Promise.all([saveAutoClassification(ctx, record), saveAutoClassification(ctx, record)]);
    expect((await loadAutoHistory(db, ctx.taskId)).results).toEqual([record]);
    await db
      .update(schema.taskSteps)
      .set({ rerunGeneration: 1 })
      .where(eq(schema.taskSteps.id, ctx.taskStepId));
    await expect(saveAutoClassification(ctx, record)).rejects.toMatchObject({
      name: 'StepSupersededError',
    });
  });
  it('replays an automatic done-row continuation without another claim or writer intent', async () => {
    const ctx = await seed();
    const chosen = [insight('one')];
    const claim = (await claimAutoRound(ctx, chosen))!;
    const intent = await ensureInsightIntent(ctx, chosen, 'auto_08e');
    expect(intent.batchId).toBe(claim.batchId);
    const outcome = await appendInsightBatch(ctx, {
      ...intent,
      stage: 'outcome',
      items: [
        { id: 'one', outcome: 'applied', changes: ['Changed code'], reason: 'Reported by writer' },
      ],
    });
    const continuation = continuationForOutcome(outcome, ctx.round)!;
    const source = await publishInsightStep(ctx, {
      status: 'done',
      endedAt: new Date(),
      output: { version: 1, continuation },
    });
    const [first, again] = await Promise.all([
      finishedStepResult(db, ctx.taskId, insightsTriageStep, source),
      finishedStepResult(db, ctx.taskId, insightsTriageStep, source),
    ]);
    expect(first).toMatchObject({
      status: 'revise',
      targetStepId: '08-phase-5-verify',
      continuation,
    });
    expect(again).toEqual(first);
    expect((await loadAutoHistory(db, ctx.taskId)).claims).toHaveLength(1);
    expect(
      (await loadInsightBatchRecords(db, ctx.taskId)).filter((r) => r.stage === 'intent'),
    ).toHaveLength(1);
  });
});
