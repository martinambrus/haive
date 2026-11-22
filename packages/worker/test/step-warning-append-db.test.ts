import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { warnStep } from '../src/project-state/branch-revert.js';
import { withMergeDirSection, claimMergeDir } from '../src/step-engine/merge-dir-claim.js';
import {
  StepSupersededError,
  appendStepWarning,
  stepWarningAppend,
} from '../src/step-engine/step-ownership.js';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { deleteUsers, seedStepRow, seedTask, seedUser } from './support/step-integrations-db.js';

const url = process.env.STEP_WARNING_APPEND_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_warning_append_test'))
  throw new Error('Use a dedicated step_warning_append_test database for step warning tests');

describe.skipIf(!url)('a step warning appended in one statement, on Postgres', () => {
  let db: Database;
  let userId: string;
  let taskId: string;

  const warningOf = async (id: string) =>
    (await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.id, id)))[0]!
      .warningMessage;
  const seed = (over: Partial<typeof schema.taskSteps.$inferInsert> = {}) =>
    seedStepRow(db, taskId, { stepId: `step-${randomUUID()}`, ...over });
  const note = (label: string) => `${label} ${randomUUID()}`;

  beforeAll(async () => {
    db = createDatabase(url as string);
    userId = await seedUser(db);
    taskId = await seedTask(db, userId, null);
  });

  afterAll(async () => {
    await deleteUsers(db, [userId]);
    await db.$client.end({ timeout: 5 });
  });

  it('keeps a warning another writer added after the caller read its row', async () => {
    const row = await seed();
    const other = note('other');
    const mine = note('mine');
    let raced = false;
    const ctx = {
      db: {
        query: {
          taskSteps: {
            findFirst: async (q: Parameters<typeof db.query.taskSteps.findFirst>[0]) => {
              const found = await db.query.taskSteps.findFirst(q);
              raced = true;
              await appendStepWarning(db, row.id, other);
              return found;
            },
          },
        },
        update: db.update.bind(db),
      } as unknown as Database,
      taskStepId: row.id,
    };
    await warnStep(ctx, [mine]);
    expect(raced).toBe(true);
    expect(await warningOf(row.id)).toBe(`${other} ${mine}`);
  });

  it('keeps attempt notes when a RAG producer has nothing to add', async () => {
    const row = await seed({ warningMessage: 'fallback note' });
    for (const note of ['retry note', null, 'retry note']) {
      await db
        .update(schema.taskSteps)
        .set({ warningMessage: stepWarningAppend(note) })
        .where(eq(schema.taskSteps.id, row.id));
    }
    expect(await warningOf(row.id)).toBe('fallback note retry note');
  });

  it('keeps the same text once', async () => {
    const a = note('a');
    const b = note('b');
    const direct = await seed();
    await appendStepWarning(db, direct.id, a);
    await appendStepWarning(db, direct.id, a);
    expect(await warningOf(direct.id)).toBe(a);
    await appendStepWarning(db, direct.id, b);
    await appendStepWarning(db, direct.id, a);
    expect(await warningOf(direct.id)).toBe(`${a} ${b}`);

    const viaWarnStep = await seed();
    await warnStep({ db, taskStepId: viaWarnStep.id }, [a, a]);
    expect(await warningOf(viaWarnStep.id)).toBe(a);
    await warnStep({ db, taskStepId: viaWarnStep.id }, [b, a]);
    expect(await warningOf(viaWarnStep.id)).toBe(`${a} ${b}`);
  });

  it('refuses a row that is not the pass own, and appends to one that is', async () => {
    for (const status of ['pending', 'skipped', 'failed'] as const) {
      const row = await seed({ status, warningMessage: 'before' });
      await expect(appendStepWarning(db, row.id, 'added')).rejects.toBeInstanceOf(
        StepSupersededError,
      );
      expect(await warningOf(row.id)).toBe('before');
    }
    for (const status of ['running', 'waiting_form', 'waiting_cli', 'done'] as const) {
      const row = await seed({ status, warningMessage: 'before' });
      await appendStepWarning(db, row.id, 'added');
      expect(await warningOf(row.id)).toBe('before added');
    }
  });

  describe('inside a merge-dir section', () => {
    const dir = () => `/tmp/${randomUUID()}`;

    it('appends under a valid claim', async () => {
      const row = await seed();
      const owner = { mergeDir: dir(), stepId: row.id, taskId, epoch: 0 };
      expect(await claimMergeDir(db, owner)).toEqual({ kind: 'claimed' });
      await withMergeDirSection(db, owner, (tx) => appendStepWarning(tx, row.id, 'in section'));
      expect(await warningOf(row.id)).toBe('in section');
    });

    it('refuses a claim held by another step', async () => {
      const row = await seed();
      const holder = await seed();
      const mergeDir = dir();
      await claimMergeDir(db, { mergeDir, stepId: holder.id, taskId, epoch: 0 });
      await expect(
        withMergeDirSection(db, { mergeDir, stepId: row.id, taskId, epoch: 0 }, (tx) =>
          appendStepWarning(tx, row.id, 'in section'),
        ),
      ).rejects.toBeInstanceOf(StepSupersededError);
      expect(await warningOf(row.id)).toBeNull();
    });

    it('refuses a task epoch that differs from the pass epoch', async () => {
      const row = await seed();
      const owner = { mergeDir: dir(), stepId: row.id, taskId, epoch: 0 };
      await claimMergeDir(db, owner);
      await expect(
        withMergeDirSection(db, { ...owner, epoch: 7 }, (tx) =>
          appendStepWarning(tx, row.id, 'in section'),
        ),
      ).rejects.toBeInstanceOf(StepSupersededError);
      expect(await warningOf(row.id)).toBeNull();
    });

    it('persists nothing from a section whose row failed', async () => {
      const row = await seed({ status: 'failed' });
      const other = await seed({ warningMessage: 'before' });
      const owner = { mergeDir: dir(), stepId: row.id, taskId, epoch: 0 };
      await claimMergeDir(db, owner);
      await expect(
        withMergeDirSection(db, owner, async (tx) => {
          await appendStepWarning(tx, other.id, 'earlier in section');
          await appendStepWarning(tx, row.id, 'in section');
        }),
      ).rejects.toBeInstanceOf(StepSupersededError);
      expect(await warningOf(row.id)).toBeNull();
      expect(await warningOf(other.id)).toBe('before');
    });
  });

  it('still clears on a reset, and the next append starts clean', async () => {
    const row = await seed({ status: 'done' });
    await appendStepWarning(db, row.id, 'first');
    await appendStepWarning(db, row.id, 'second');
    expect(await warningOf(row.id)).toBe('first second');
    const reset = await resetStepAndDownstream(db, taskId, row.stepId, row.round);
    expect(reset).not.toBeNull();
    expect(await warningOf(row.id)).toBeNull();
    await db
      .update(schema.taskSteps)
      .set({ status: 'running' })
      .where(eq(schema.taskSteps.id, row.id));
    await appendStepWarning(db, row.id, 'third');
    expect(await warningOf(row.id)).toBe('third');
  });
});
