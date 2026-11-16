import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { eq, sql } from 'drizzle-orm';
import { unobservedToolUsage } from '../src/cli-executor/tool-usage.js';
import { backfillToolUsage } from '../src/queues/cli-exec/tool-usage-backfill.js';

const url = process.env.READ_EXPOSURE_BACKFILL_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/read_exposure_backfill_test')) {
  throw new Error('Use a dedicated read_exposure_backfill_test database');
}

describe.skipIf(!url)('read exposure backfill PostgreSQL selection and CAS', () => {
  let db: Database;
  const userId = randomUUID();
  const taskId = randomUUID();
  beforeAll(async () => {
    db = createDatabase(url!);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    await db
      .insert(schema.tasks)
      .values({ id: taskId, userId, type: 'workflow', title: 'fixture' });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.$client.end({ timeout: 5 });
  });

  it('repairs null, malformed and older reads once, preserves current/future/swept evidence and other columns', async () => {
    const current = unobservedToolUsage('stream');
    const { reads: _reads, ...facts } = current;
    const states = [
      { name: 'SQL NULL', usage: undefined },
      { name: 'jsonb null', usage: null },
      { name: 'missing reads', usage: facts },
      { name: 'reads null', usage: { ...facts, reads: null } },
      { name: 'no numeric version', usage: { ...facts, reads: {} } },
      { name: 'string version', usage: { ...facts, reads: { version: '1' } } },
      { name: 'old version', usage: { ...current, reads: { ...current.reads, version: 0 } } },
      { name: 'current version', usage: current },
      { name: 'future version', usage: { ...current, reads: { ...current.reads, version: 2 } } },
      {
        name: 'swept old version',
        usage: { ...current, reads: { ...current.reads, version: 0 } },
        swept: true,
      },
    ];
    const ids: string[] = [];
    const tokenUsage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    for (const state of states) {
      const id = randomUUID();
      ids.push(id);
      await db.insert(schema.cliInvocations).values({
        id,
        taskId,
        mode: 'cli',
        prompt: 'fixture',
        endedAt: new Date('2026-10-01T00:00:00.123Z'),
        streamLog: state.swept
          ? null
          : JSON.stringify({ type: 'assistant', message: { id: 'a', content: [] } }),
        toolUsage: state.usage === undefined ? null : sql`${JSON.stringify(state.usage)}::jsonb`,
        tokenUsage,
      });
    }
    const rows = () =>
      db
        .select({
          id: schema.cliInvocations.id,
          toolUsage: schema.cliInvocations.toolUsage,
          sqlNull: sql<boolean>`${schema.cliInvocations.toolUsage} IS NULL`,
          tokenUsage: schema.cliInvocations.tokenUsage,
          cost: schema.cliInvocations.cost,
          endedAt: schema.cliInvocations.endedAt,
          xmin: sql<string>`xmin::text`,
        })
        .from(schema.cliInvocations)
        .where(eq(schema.cliInvocations.taskId, taskId))
        .orderBy(schema.cliInvocations.id);
    const before = await rows();
    expect(before.find((r) => r.id === ids[0])?.sqlNull).toBe(true);
    expect(before.find((r) => r.id === ids[1])?.sqlNull).toBe(false);
    const opts = { budgetMs: 5000, batchSize: 2, apply: true };
    expect(await backfillToolUsage(db, opts)).toMatchObject({
      examined: 7,
      written: 7,
      remaining: 0,
    });
    const after = await rows();
    for (const [i, id] of ids.entries()) {
      const prior = before.find((r) => r.id === id)!;
      const saved = after.find((r) => r.id === id)!;
      if (i >= 7) expect(saved, states[i]!.name).toEqual(prior);
      else {
        expect(saved.toolUsage?.reads, states[i]!.name).toMatchObject({
          version: 1,
          coverage: 'full',
        });
        expect(saved.xmin).not.toBe(prior.xmin);
        if (prior.toolUsage) {
          const { reads: _old, ...originalFacts } = prior.toolUsage;
          const { reads: _new, ...savedFacts } = saved.toolUsage!;
          expect(savedFacts).toEqual(originalFacts);
        }
      }
      expect(saved.tokenUsage).toEqual(prior.tokenUsage);
      expect(saved.cost).toEqual(prior.cost);
      expect(saved.endedAt).toEqual(prior.endedAt);
    }
    expect(await backfillToolUsage(db, opts)).toMatchObject({
      examined: 0,
      written: 0,
      remaining: 0,
    });
    expect(await rows()).toEqual(after);
  });
});
