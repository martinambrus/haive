import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { TYPE_DRAFT_MESSAGE_EVENT } from '@haive/shared/modularity';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import {
  loadDraftCatalog,
  typeDraftStep,
} from '../src/step-engine/steps/type-draft/01-type-draft.js';
import { TYPE_DRAFT_REPAIR_EVENT } from '../src/step-engine/steps/type-draft/_type-draft.js';

const url = process.env.TYPE_DRAFT_DETECT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/type_draft_detect_test'))
  throw new Error(
    'Use a dedicated type_draft_detect_test database for the type draft detect tests',
  );

const MODULE_ID = 'tdfx';
const MODULE_STEP = `module.${MODULE_ID}.report`;
const moduleEntry = {
  stepId: MODULE_STEP,
  label: 'Module report',
  group: 'check',
  dispatchesCli: false,
  requires: [],
  provides: [],
};

describe.skipIf(!url)('type draft detect on Postgres', () => {
  let db: Database;
  const userId = randomUUID();
  const taskIds: string[] = [];

  const newTask = async (): Promise<string> => {
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'type_draft',
        title: 'Draft a task type',
        repositoryId: null,
        metadata: { anchorRepositoryId: null },
        runListSnapshot: ['01-type-draft'],
        status: 'created',
      })
      .returning({ id: schema.tasks.id });
    taskIds.push(task!.id);
    return task!.id;
  };
  const event = (
    taskId: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt?: Date,
  ) =>
    db
      .insert(schema.taskEvents)
      .values({ taskId, eventType, payload, ...(createdAt ? { createdAt } : {}) });
  const detect = (taskId: string) =>
    typeDraftStep.detect!({ db, taskId } as unknown as StepContext);

  beforeAll(async () => {
    db = createDatabase(url as string);
    registerStepsOnce();
    await syncStepCatalog(db, stepRegistry);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'type-draft-detect@test.local',
      emailBlindIndex: `type-draft-detect-${randomBytes(4).toString('hex')}`,
      passwordHash: 'not-real',
      role: 'admin',
      status: 'active',
      tokenVersion: 0,
    });
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.stepCatalog).where(eq(schema.stepCatalog.source, `module:${MODULE_ID}`));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, MODULE_ID));
    await db.$client.end({ timeout: 5 });
  });

  describe('loadDraftCatalog', () => {
    const moduleRow = {
      stepId: MODULE_STEP,
      source: `module:${MODULE_ID}`,
      title: 'Module report',
      workflowType: 'x',
      dispatchesCli: false,
      allowSkip: false,
      providerSensitive: false,
      composable: true,
      entry: moduleEntry,
    };

    it('offers the composable steps of the step catalog with the descriptions of the live registry', async () => {
      const catalog = await loadDraftCatalog(db);
      expect(catalog.map((s) => s.entry.stepId).sort()).toEqual(
        CORE_COMPOSABLE_STEPS.map((e) => e.stepId).sort(),
      );
      for (const { entry, description } of catalog) {
        expect(description, entry.stepId).toBe(
          stepRegistry.get(entry.stepId)?.metadata.description ?? '',
        );
      }
      expect(catalog.some((s) => s.entry.stepId === '01-type-draft')).toBe(false);
    });

    it('offers a module step while its module is on, and not once it is turned off', async () => {
      await db
        .insert(schema.modules)
        .values({
          moduleId: MODULE_ID,
          packageName: '@haive/module-tdfx',
          name: 'Type draft fixture',
          installedVersion: '0.0.1',
        })
        .onConflictDoNothing();
      await db.insert(schema.stepCatalog).values(moduleRow).onConflictDoNothing();
      expect((await loadDraftCatalog(db)).some((s) => s.entry.stepId === MODULE_STEP)).toBe(true);

      await db
        .update(schema.modules)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.modules.moduleId, MODULE_ID));
      expect((await loadDraftCatalog(db)).some((s) => s.entry.stepId === MODULE_STEP)).toBe(false);

      await db
        .update(schema.modules)
        .set({ deactivatedAt: null })
        .where(eq(schema.modules.moduleId, MODULE_ID));
      expect((await loadDraftCatalog(db)).some((s) => s.entry.stepId === MODULE_STEP)).toBe(true);
    });

    it('leaves out a composable row whose entry does not parse', async () => {
      await db
        .update(schema.stepCatalog)
        .set({ entry: { stepId: MODULE_STEP, label: 7 } })
        .where(eq(schema.stepCatalog.stepId, MODULE_STEP));
      expect((await loadDraftCatalog(db)).some((s) => s.entry.stepId === MODULE_STEP)).toBe(false);
      await db
        .update(schema.stepCatalog)
        .set({ entry: moduleEntry })
        .where(eq(schema.stepCatalog.stepId, MODULE_STEP));
    });
  });

  describe('detect', () => {
    it('offers the catalog and the personas, and has nothing pending at the start', async () => {
      const d = await detect(await newTask());
      expect(d.steps.length).toBeGreaterThanOrEqual(CORE_COMPOSABLE_STEPS.length);
      expect(d.personas.length).toBeGreaterThan(0);
      expect(d).toMatchObject({
        transcript: [],
        pendingQuestion: null,
        currentDraft: null,
        repairPending: null,
      });
    });

    it('reads the seeded opening message as the pending question', async () => {
      const taskId = await newTask();
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, { role: 'user', body: 'a TODO audit' });
      const d = await detect(taskId);
      expect(d.pendingQuestion).toBe('a TODO audit');
      expect(d.transcript).toEqual([{ role: 'user', body: 'a TODO audit' }]);
    });

    it('reads the log in time order, whatever order the rows went in', async () => {
      const taskId = await newTask();
      const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, { role: 'user', body: 'second' }, t(3));
      await event(
        taskId,
        TYPE_DRAFT_MESSAGE_EVENT,
        { role: 'assistant', body: 'answer', draft: null, issues: [], warnings: [], dropped: [] },
        t(2),
      );
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, { role: 'user', body: 'first' }, t(1));
      const d = await detect(taskId);
      expect(d.transcript.map((m) => m.body)).toEqual(['first', 'answer', 'second']);
      expect(d.pendingQuestion).toBe('second');
    });

    it('holds a repair that follows the pending message until a reply closes it', async () => {
      const taskId = await newTask();
      const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n));
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, { role: 'user', body: 'ask' }, t(1));
      await event(
        taskId,
        TYPE_DRAFT_REPAIR_EVENT,
        { reply: 'first try', draft: { slug: 'x' }, issues: [], warnings: [], dropped: [] },
        t(2),
      );
      const waiting = await detect(taskId);
      expect(waiting.pendingQuestion).toBe('ask');
      expect(waiting.repairPending).toMatchObject({ reply: 'first try' });

      await event(
        taskId,
        TYPE_DRAFT_MESSAGE_EVENT,
        { role: 'assistant', body: 'done', draft: null, issues: [], warnings: [], dropped: [] },
        t(3),
      );
      const closed = await detect(taskId);
      expect(closed.pendingQuestion).toBeNull();
      expect(closed.repairPending).toBeNull();
    });

    it('reads only its own task and only its own event types', async () => {
      const mine = await newTask();
      const other = await newTask();
      await event(other, TYPE_DRAFT_MESSAGE_EVENT, { role: 'user', body: 'not mine' });
      await event(mine, 'plan_merge.message', { role: 'user', body: 'wrong type' });
      const d = await detect(mine);
      expect(d.transcript).toEqual([]);
      expect(d.pendingQuestion).toBeNull();
    });

    it('does not write to the task_events table', async () => {
      const taskId = await newTask();
      await detect(taskId);
      const rows = await db
        .select({ id: schema.taskEvents.id })
        .from(schema.taskEvents)
        .where(inArray(schema.taskEvents.taskId, [taskId]));
      expect(rows).toEqual([]);
    });
  });
});
