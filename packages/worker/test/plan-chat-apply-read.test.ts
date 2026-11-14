import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { eq } from 'drizzle-orm';
import { applyAgentPatch } from '../src/step-engine/steps/plan/_plan-prompt.js';
import { planChatStep } from '../src/step-engine/steps/plan/01-plan-chat.js';
import { chatPlanContext } from '../src/step-engine/steps/plan/_plan-chat-context.js';
import { createPlanChatSnapshot } from '../src/plan/chat-snapshot.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/plan/mirror.js', () => ({ writePlanMirror: vi.fn(async () => {}) }));
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture() {
  const fake = createFakeDb({
    tasks: schema.tasks,
    planNodes: schema.planNodes,
    planNodeEdges: schema.planNodeEdges,
    planNodeMessages: schema.planNodeMessages,
    planMirrorState: schema.planMirrorState,
  });
  fake.insert(schema.tasks, {
    id: id(90),
    userId: id(91),
    repositoryId: id(92),
    metadata: { planNodeId: id(2) },
  });
  const base = {
    repositoryId: id(92),
    title: 'Title',
    body: 'Original body',
    kind: 'component',
    status: 'todo',
    version: 3,
    ordinal: 0,
    taskable: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const rows = [
    { id: id(1), parentId: null, path: `/${id(1)}/` },
    { id: id(2), parentId: id(1), path: `/${id(1)}/${id(2)}/` },
    { id: id(3), parentId: id(1), path: `/${id(1)}/${id(3)}/` },
    {
      id: id(4),
      parentId: id(3),
      path: `/${id(1)}/${id(3)}/${id(4)}/`,
      title: 'Off-focus node ' + 'long '.repeat(40),
    },
  ];
  for (const row of rows) fake.insert(schema.planNodes, { ...base, ...row });
  fake.insert(schema.planMirrorState, { repositoryId: id(92), revision: 1 });
  fake.insert(schema.planNodeMessages, {
    id: id(93),
    nodeId: id(2),
    taskId: id(90),
    role: 'user',
    body: 'Change the other branch',
    createdAt: new Date(0),
  });
  const db = fake.db as unknown as Database;
  const ctx = { db, taskId: id(90), userId: id(91), repoPath: '/unused', logger: { warn() {} } };
  const detected = await planChatStep.detect!(ctx as never);
  const node = async () =>
    (
      await db
        .select()
        .from(schema.planNodes)
        .where(eq(schema.planNodes.id, id(4)))
    )[0];
  const answer = async (op: Record<string, unknown>, useDb = db) => {
    const result = await planChatStep.apply({ ...ctx, db: useDb } as never, {
      detected,
      formValues: {},
      llmOutput: { reply: 'Proposed change', ops: [op] },
      llmInvocationId: null,
      iteration: 0,
      previousIterations: [],
    });
    const turns = await db.select().from(schema.planNodeMessages);
    return { result, last: turns.at(-1) };
  };
  return { db, detected, node, answer, ctx };
}

describe('plan chat patches use the dispatch read', () => {
  it.each(['Edited replacement', ''])(
    'collects a legacy edit or an explicit end without stranding the stored turn: %s',
    async (message) => {
      const f = await fixture();
      await f.db
        .update(schema.planNodeMessages)
        .set({ body: 'x'.repeat(20_001) })
        .where(eq(schema.planNodeMessages.id, id(93)));
      const detected = await planChatStep.detect!(f.ctx as never);
      const out = await planChatStep.apply(f.ctx as never, {
        detected,
        formValues: { message },
        llmOutput: null,
        llmInvocationId: null,
        iteration: 0,
        previousIterations: [],
      });
      expect(out.pass).toBe('collect');
      expect(out.continueRequested).toBe(Boolean(message));
      const next = await planChatStep.detect!(f.ctx as never);
      expect(next.pendingQuestion).toBe(message || null);
      if (message)
        expect(planChatStep.llm!.skipIf!({ detected: next, formValues: {} })).toBe(false);
    },
  );

  it('hydrates a pre-upgrade plan read while preserving the turn being answered', async () => {
    const f = await fixture();
    const old = { ...f.detected, planRead: undefined, planMarkdown: 'old unversioned whole plan' };
    await f.db
      .update(schema.planNodeMessages)
      .set({ body: 'A newer turn' })
      .where(eq(schema.planNodeMessages.id, id(93)));
    await planChatStep.llm!.prepare!({ ctx: f.ctx as never, detected: old, formValues: {} });
    expect(old.planRead).toBeDefined();
    expect(old.pendingQuestion).toBe('Change the other branch');
    expect(old.transcript.at(-1)?.body).toBe('Change the other branch');
    expect(old.planMarkdown).toBe('');
  });

  it('patches a node beyond the focus neighbourhood using the index version', async () => {
    const f = await fixture();
    const prompt = planChatStep.llm!.buildPrompt({ detected: f.detected, formValues: {} });
    expect(prompt.split('## Bounded plan index')[0]).not.toContain(`node:${id(4)}`);
    expect(prompt).toContain(`node:${id(4)}`);
    const out = await f.answer({
      op: 'upsert',
      nodeRef: id(4),
      expectedVersion: 3,
      body: 'Changed',
    });
    expect(out.result.updated).toBe(1);
    expect(await f.node()).toMatchObject({ body: 'Changed', version: 4 });
  });
  it('patches an index-omitted node using the same read from the snapshot file', async () => {
    const f = await fixture();
    expect(chatPlanContext(f.detected.planRead!, id(2), 1800)).not.toContain(`node:${id(4)}`);
    const root = await mkdtemp(join(tmpdir(), 'plan-chat-apply-'));
    try {
      const snapshot = await createPlanChatSnapshot(root, {
        schemaVersion: 1,
        userId: id(91),
        taskId: id(90),
        repositoryId: id(92),
        invocationId: id(94),
        ...f.detected.planRead!,
      });
      const read = JSON.parse(await readFile(join(root, snapshot.subpath), 'utf8'));
      const target = read.nodes.find((n: { id: string }) => n.id === id(4));
      const out = await f.answer({
        op: 'upsert',
        nodeRef: target.id,
        expectedVersion: target.version,
        body: 'Snapshot change',
      });
      expect(out.result.updated).toBe(1);
      expect(await f.node()).toMatchObject({ body: 'Snapshot change', version: 4 });
      await snapshot.remove();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([true, false])(
    'refuses a write that races between the applier read and UPDATE (chat=%s)',
    async (chat) => {
      const f = await fixture();
      let raced = false;
      const racing = new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'transaction') return Reflect.get(target, key, receiver);
          return (fn: (tx: unknown) => unknown) =>
            target.transaction(async (tx) =>
              fn(
                new Proxy(tx, {
                  get(inner, method, recv) {
                    if (method !== 'update') return Reflect.get(inner, method, recv);
                    return (table: typeof schema.planNodes) => ({
                      set: (values: Record<string, unknown>) => ({
                        where: (condition: ReturnType<typeof eq>) => {
                          const query = inner.update(table).set(values).where(condition);
                          const race = async () => {
                            if (!raced && table === schema.planNodes) {
                              raced = true;
                              await target
                                .update(schema.planNodes)
                                .set({ version: 4, body: 'Racing canvas edit' })
                                .where(eq(schema.planNodes.id, id(4)));
                            }
                          };
                          return {
                            then: async (
                              resolve: (v: unknown) => unknown,
                              reject: (e: unknown) => unknown,
                            ) => {
                              try {
                                await race();
                                return resolve(await query);
                              } catch (e) {
                                return reject(e);
                              }
                            },
                            returning: (fields: { id: typeof schema.planNodes.id }) => ({
                              then: async (
                                resolve: (v: unknown) => unknown,
                                reject: (e: unknown) => unknown,
                              ) => {
                                try {
                                  await race();
                                  return resolve(await query.returning(fields));
                                } catch (e) {
                                  return reject(e);
                                }
                              },
                            }),
                          };
                        },
                      }),
                    });
                  },
                }),
              ),
            );
        },
      });
      const op = { op: 'upsert', nodeRef: id(4), expectedVersion: 3, body: 'Raced agent change' };
      if (chat) {
        const out = await f.answer(op, racing);
        expect(out.result.updated).toBe(0);
        expect(out.last?.body).toMatch(/changed|modified/);
      } else {
        await expect(
          applyAgentPatch(racing, { ops: [op] }, { repositoryId: id(92), sourceTaskId: id(90) }),
        ).rejects.toMatchObject({ kind: 'conflict' });
      }
      expect(await f.node()).toMatchObject({ body: 'Racing canvas edit', version: 4 });
    },
  );

  it('reports a changed-after-read refusal without retrying at a newer version', async () => {
    const f = await fixture();
    await f.db
      .update(schema.planNodes)
      .set({ version: 4, body: 'Canvas edit' })
      .where(eq(schema.planNodes.id, id(4)));
    const out = await f.answer({
      op: 'upsert',
      nodeRef: id(4),
      expectedVersion: 3,
      body: 'Agent change',
    });
    expect(out.result.error).toMatch(/expected version 3, found 4/);
    expect(out.last?.body).toContain('expected version 3, found 4');
    expect(await f.node()).toMatchObject({ body: 'Canvas edit', version: 4 });
  });
  it.each([{ body: 'Unversioned' }, { ordinal: 2 }])(
    'reports an unversioned existing-node update as dropped: %s',
    async (fields) => {
      const f = await fixture();
      const out = await f.answer({ op: 'upsert', nodeRef: id(4), ...fields });
      expect(out.result.updated).toBe(0);
      expect(out.last?.body).toContain('without its expectedVersion');
      expect(await f.node()).toMatchObject({ body: 'Original body', version: 3 });
    },
  );
});
