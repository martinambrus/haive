import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';
import {
  applyContextInventory,
  inventoryContext,
  readContextBackup,
  undoContextBackup,
  type Inventory,
} from '../src/maintenance/context-backfill.js';

/** The caller creates/migrates a dedicated test database. Never reads .env/dev defaults. */
const url = process.env.CONTEXT_BACKFILL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t402_context_backfill_test'))
  throw new Error('Use a dedicated t402_context_backfill_test database');
describe.skipIf(!url)('context operator PostgreSQL fencing', () => {
  let db: ReturnType<typeof createDatabase>;
  let root: string;
  let userId: string;
  let fileNumber = 0;
  const nextFile = () => `backups/plan-${++fileNumber}.json`;
  const transcript = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5' },
    {
      type: 'assistant',
      message: {
        id: 'a',
        model: 'claude-opus-5',
        usage: { input_tokens: 100, cache_read_input_tokens: 50000, output_tokens: 1 },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'b',
        model: 'claude-opus-5',
        usage: { input_tokens: 200, cache_read_input_tokens: 80000, output_tokens: 1 },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 300, cache_read_input_tokens: 130000, output_tokens: 2 },
      modelUsage: { 'claude-opus-5': { contextWindow: 1000000 } },
    },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');
  beforeAll(async () => {
    db = createDatabase(url!);
    root = await mkdtemp(path.join(tmpdir(), 't402-context-'));
    await mkdir(path.join(root, 'backups'));
    userId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'fixture',
      emailBlindIndex: userId,
      passwordHash: 'fixture',
    });
  }, 120000);
  afterAll(async () => {
    if (db && userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db?.$client.end({ timeout: 5 });
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function seed() {
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, type: 'workflow', title: 'fixture', status: 'completed' })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: 'fixture',
        stepIndex: 1,
        title: 'fixture',
        status: 'done',
        endedAt: new Date('2026-10-01T12:00:00Z'),
        contextTokens: 130300,
        contextWindowSize: 200000,
        contextLeftPercent: 35,
        usageFiveHourPct: 12,
        usageSevenDayPct: 34,
        usageDailyPct: 56,
      })
      .returning();
    const [invocation] = await db
      .insert(schema.cliInvocations)
      .values({
        taskId: task!.id,
        taskStepId: step!.id,
        mode: 'cli',
        prompt: 'SECRET_PROMPT_SENTINEL',
        rawOutput: 'PRIVATE_RAW_SENTINEL',
        streamLog: transcript,
        endedAt: step!.endedAt,
        tokenUsage: {
          inputTokens: 300,
          cacheReadTokens: 130000,
          outputTokens: 2,
          totalTokens: 130302,
          costUsd: 1.23,
        },
      })
      .returning();
    return {
      step: step!,
      invocation: invocation!,
      inventory: await inventoryContext(db, { stepId: step!.id }),
    };
  }
  async function full(id: string) {
    const [row] = await db.execute<{ row: Record<string, unknown>; version: string }>(
      sql`select to_jsonb(s) as row, xmin::text as version from task_steps s where id=${id}::uuid`,
    );
    return row!;
  }
  it('dry-run bounds scope and does not alter any row; save failure/overwrite do not write', async () => {
    const seeded = await seed();
    const before = await full(seeded.step.id);
    expect(seeded.inventory).toMatchObject({ candidate: 1, changed: 1, missing: 0 });
    expect(seeded.inventory.rows[0]!.after).toEqual({ tokens: 80200, window: 1000000, left: 92 });
    expect(await full(seeded.step.id)).toEqual(before);
    await expect(
      applyContextInventory(db, seeded.inventory, root, 'missing/file.json'),
    ).rejects.toThrow();
    expect(await full(seeded.step.id)).toEqual(before);
    const file = nextFile();
    const applied = await applyContextInventory(db, seeded.inventory, root, file);
    expect(applied.written).toBe(1);
    const image = await readFile(path.join(root, file), 'utf8');
    expect(image).not.toContain('SECRET_PROMPT_SENTINEL');
    expect(image).not.toContain('PRIVATE_RAW_SENTINEL');
    expect(image).not.toContain('cache_read_input_tokens');
    const after = await full(seeded.step.id);
    expect(after.version).toBe((await readContextBackup(root, file)).afterVersion);
    expect(after.row).toEqual({
      ...before.row,
      context_tokens: 80200,
      context_window_size: 1000000,
      context_left_percent: 92,
    });
    await expect(applyContextInventory(db, seeded.inventory, root, file)).rejects.toThrow();
    expect(await full(seeded.step.id)).toEqual(after);
    expect(await inventoryContext(db, { stepId: seeded.step.id })).toMatchObject({
      candidate: 1,
      changed: 0,
      unchanged: 1,
    });
    const backup = await readContextBackup(root, file);
    expect(await undoContextBackup(db, backup)).toMatchObject({ written: 0, conflicts: 0 });
    expect(await full(seeded.step.id)).toEqual(after);
    expect(await undoContextBackup(db, backup, true)).toMatchObject({ written: 1, conflicts: 0 });
    expect((await full(seeded.step.id)).row).toEqual(before.row);
    expect(await undoContextBackup(db, backup, true)).toMatchObject({ written: 0, conflicts: 1 });
    const [inv] = await db.execute<{ usage: unknown }>(
      sql`select token_usage as usage from cli_invocations where id=${seeded.invocation.id}::uuid`,
    );
    expect(inv!.usage).toEqual(seeded.invocation.tokenUsage);
  });
  it('refuses reopened/new completion rows and changed invocation evidence', async () => {
    for (const change of ['reopened', 'completion', 'evidence', 'new-invocation'] as const) {
      const seeded = await seed();
      if (change === 'reopened')
        await db.execute(
          sql`update task_steps set status='running' where id=${seeded.step.id}::uuid`,
        );
      if (change === 'completion')
        await db.execute(
          sql`update task_steps set ended_at=ended_at+interval '1 second' where id=${seeded.step.id}::uuid`,
        );
      if (change === 'evidence')
        await db.execute(
          sql`update cli_invocations set stream_log=stream_log||E'\nchanged' where id=${seeded.invocation.id}::uuid`,
        );
      if (change === 'new-invocation')
        await db.insert(schema.cliInvocations).values({
          taskId: seeded.step.taskId,
          taskStepId: seeded.step.id,
          mode: 'cli',
          prompt: 'new',
          endedAt: new Date(),
        });
      const before = await full(seeded.step.id);
      expect(await applyContextInventory(db, seeded.inventory, root, nextFile())).toMatchObject({
        written: 0,
        conflicts: 1,
      });
      expect(await full(seeded.step.id)).toEqual(before);
    }
  });
  it('NOWAIT conflicts with a live invocation lock without deadlocking; partial batches and undo conflicts are explicit', async () => {
    const first = await seed();
    const second = await seed();
    const mixed: Inventory = {
      ...first.inventory,
      rows: [...first.inventory.rows, ...second.inventory.rows],
    };
    let unlock!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const lock = db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from cli_invocations where id=${first.invocation.id}::uuid for update`,
      );
      ready();
      await release;
    });
    await held;
    const file = nextFile();
    try {
      expect(await applyContextInventory(db, mixed, root, file)).toMatchObject({
        planned: 2,
        written: 1,
        conflicts: 1,
      });
    } finally {
      unlock();
      await lock;
    }
    const backup = await readContextBackup(root, file);
    // Even an unrelated subsequent row update advances xmin: undo cannot overwrite it.
    await db.execute(sql`update task_steps set title='new title' where id=${second.step.id}::uuid`);
    expect(await undoContextBackup(db, backup, true)).toMatchObject({
      planned: 2,
      written: 0,
      conflicts: 2,
    });
    expect((await full(second.step.id)).row.context_tokens).toBe(80200);
  });
  it('pagination is bounded and validates scope', async () => {
    const bounded = await inventoryContext(db, { limit: 1 });
    expect(bounded.candidate).toBe(1);
    expect(bounded.hasMore).toBe(true);
    const next = await inventoryContext(db, { limit: 1, after: bounded.nextAfter! });
    expect(next.nextAfter! > bounded.nextAfter!).toBe(true);
    await expect(inventoryContext(db, { limit: 101 })).rejects.toThrow();
  });
});
