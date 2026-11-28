import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, schema } from '@haive/database';
import {
  providerBreakdownWhere,
  sumProviderBreakdownWhere,
  UNKNOWN_TIER_COST_LIMIT,
} from '@haive/shared/stats-server';
import { enrichStepsWithCliStats, sumTaskTokens } from '../src/routes/tasks/_helpers.js';
import {
  loadUnknownTierInvocations,
  UNKNOWN_TIER_INVOCATION_LIMIT,
} from '../src/routes/cli-pricing.js';

const url = process.env.TIERED_PRICING_SQL_TEST_URL;
if (url && new URL(url).pathname !== '/tiered_pricing_sql_test')
  throw new Error('Use a dedicated tiered_pricing_sql_test database');

describe.skipIf(!url)('tier inventories and spend queries on migrated PostgreSQL', () => {
  const db = url ? createDatabase(url) : undefined;
  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
  });

  it('executes the production aggregate and admin query, retaining identity and excluding bounds from sums', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    await db!.transaction(async (tx) => {
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
      await tx.insert(schema.users).values({
        id: userId,
        emailEncrypted: 'test',
        emailBlindIndex: 'tiered-sql-test',
        passwordHash: 'test',
      });
      const [task] = await tx
        .insert(schema.tasks)
        .values({ userId, type: 'workflow', title: 'pricing test' })
        .returning();
      const [step] = await tx
        .insert(schema.taskSteps)
        .values({ taskId: task!.id, stepId: 'test', stepIndex: 1, title: 'test' })
        .returning();
      const [provider] = await tx
        .insert(schema.cliProviders)
        .values({ userId, name: 'codex', label: 'test', authMode: 'api_key' })
        .returning();
      const snapshot = (
        source: 'computed' | 'none',
        costUsd: number,
        billable: boolean,
        tier?: { state: 'exact' | 'unknown'; split: []; lowUsd?: number; highUsd?: number },
      ) => ({
        source,
        costUsd,
        billable,
        currency: 'USD',
        modelKey: 'model',
        priceRowId: null,
        rates: null,
        cacheTtl: '5m' as const,
        unpricedBuckets: [],
        ...(tier ? { tier } : {}),
      });
      const costs = [
        snapshot('computed', 7, true),
        snapshot('computed', 3, false),
        snapshot('none', 0, false, { state: 'unknown', split: [], lowUsd: 1, highUsd: 5 }),
        snapshot('none', 0, false, { state: 'unknown', split: [] }),
        snapshot('none', 0, false),
        snapshot('computed', 0, true, { state: 'exact', split: [] }),
      ];
      const ids = costs.map(
        (_, i) => `00000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`,
      );
      await tx.insert(schema.cliInvocations).values(
        costs.map((cost, i) => ({
          id: ids[i]!,
          taskId: task!.id,
          taskStepId: step!.id,
          cliProviderId: provider!.id,
          mode: 'cli' as const,
          prompt: 'test',
          cost,
          tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          endedAt: new Date('2026-11-01T00:00:00Z'),
        })),
      );
      // The helpers accept a transaction at runtime; no connection is opened here.
      const scoped = tx as unknown as NonNullable<typeof db>;
      const [card] = await providerBreakdownWhere(scoped, eq(schema.tasks.id, task!.id));
      expect(card).toMatchObject({
        costUsd: 7,
        notionalCostUsd: 3,
        unpricedInvocations: 3,
        invocations: 6,
      });
      expect(UNKNOWN_TIER_COST_LIMIT).toBe(50);
      expect(card!.unknownTierCount).toBe(2);
      const [capped] = await providerBreakdownWhere(scoped, eq(schema.tasks.id, task!.id), true, 1);
      expect(capped).toMatchObject({
        unknownTierCount: 2,
        invocations: 6,
        costUsd: 7,
        notionalCostUsd: 3,
        unpricedInvocations: 3,
      });
      expect(capped!.unknownTierCosts).toEqual([
        { id: ids[2], modelKey: 'model', lowUsd: 1, highUsd: 5 },
      ]);
      expect(card!.unknownTierCosts).toEqual([
        { id: ids[2], modelKey: 'model', lowUsd: 1, highUsd: 5 },
        { id: ids[3], modelKey: 'model' },
      ]);
      const [stats] = await sumProviderBreakdownWhere(scoped, eq(schema.tasks.id, task!.id));
      expect(stats).toMatchObject({ costUsd: 7, notionalCostUsd: 3, unpricedInvocations: 3 });
      expect(stats).not.toHaveProperty('unknownTierCosts');
      expect(stats).not.toHaveProperty('unknownTierCount');
      expect(UNKNOWN_TIER_INVOCATION_LIMIT).toBe(50);
      expect(await loadUnknownTierInvocations(scoped)).toEqual([
        { id: ids[2], taskId: task!.id, modelKey: 'model', tier: costs[2]!.tier },
        { id: ids[3], taskId: task!.id, modelKey: 'model', tier: costs[3]!.tier },
      ]);
      expect((await loadUnknownTierInvocations(scoped, 1)).map((r) => r.id)).toEqual([ids[2]]);
      await tx
        .update(schema.cliInvocations)
        .set({ supersededAt: new Date() })
        .where(eq(schema.cliInvocations.id, ids[2]!));
      expect(
        (await providerBreakdownWhere(scoped, eq(schema.tasks.id, task!.id)))[0]!.unknownTierCosts,
      ).toEqual([{ id: ids[3], modelKey: 'model' }]);
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
  });

  it('keeps an unreported output unknown in the provider, step and task sums', async () => {
    const userId = '00000000-0000-4000-8000-000000000002';
    await db!.transaction(async (tx) => {
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
      await tx.insert(schema.users).values({
        id: userId,
        emailEncrypted: 'test',
        emailBlindIndex: 'unknown-output-sql-test',
        passwordHash: 'test',
      });
      const makeTask = async (title: string) => {
        const [task] = await tx
          .insert(schema.tasks)
          .values({ userId, type: 'workflow', title })
          .returning();
        const [step] = await tx
          .insert(schema.taskSteps)
          .values({ taskId: task!.id, stepId: 'test', stepIndex: 1, title: 'test' })
          .returning();
        return { task: task!, step: step! };
      };
      const [provider] = await tx
        .insert(schema.cliProviders)
        .values({ userId, name: 'codex', label: 'test', authMode: 'api_key' })
        .returning();
      const seed = async (
        t: { task: { id: string }; step: { id: string } },
        usages: Array<Record<string, number | null> | null>,
      ) => {
        await tx.insert(schema.cliInvocations).values(
          usages.map((usage) => ({
            taskId: t.task.id,
            taskStepId: t.step.id,
            cliProviderId: provider!.id,
            mode: 'cli' as const,
            prompt: 'test',
            tokenUsage: usage as never,
            endedAt: new Date('2026-11-01T00:00:00Z'),
          })),
        );
      };
      const scoped = tx as unknown as NonNullable<typeof db>;
      const mixed = await makeTask('mixed');
      await seed(mixed, [
        { inputTokens: 10, outputTokens: null, totalTokens: 10 },
        { inputTokens: 10, outputTokens: 40, totalTokens: 50 },
        { inputTokens: 10, outputTokens: null, totalTokens: 10 },
        { inputTokens: 10, totalTokens: 10 },
        null,
      ]);
      const [mixedCard] = await sumProviderBreakdownWhere(
        scoped,
        eq(schema.tasks.id, mixed.task.id),
      );
      expect(mixedCard).toMatchObject({ outputTokens: 40, outputUnknownRuns: 3 });
      const mixedTotals = (await sumTaskTokens(scoped, [mixed.task.id])).get(mixed.task.id);
      expect(mixedTotals).toMatchObject({ outputTokens: 40, outputUnknownRuns: 3 });
      const [mixedStep] = await enrichStepsWithCliStats(scoped, mixed.task.id, [
        { id: mixed.step.id },
      ]);
      expect(mixedStep!.tokenUsage).toMatchObject({ outputTokens: 40, outputUnknownRuns: 3 });

      const allUnknown = await makeTask('all unknown');
      await seed(allUnknown, [
        { inputTokens: 10, outputTokens: null, totalTokens: 10 },
        { inputTokens: 5, outputTokens: null, totalTokens: 5 },
      ]);
      const [unknownCard] = await sumProviderBreakdownWhere(
        scoped,
        eq(schema.tasks.id, allUnknown.task.id),
      );
      expect(unknownCard).toMatchObject({ outputTokens: null, outputUnknownRuns: 2 });
      const unknownTotals = (await sumTaskTokens(scoped, [allUnknown.task.id])).get(
        allUnknown.task.id,
      );
      expect(unknownTotals).toMatchObject({ inputTokens: 15, outputTokens: null });
      expect(unknownTotals!.outputUnknownRuns).toBe(2);
      const [unknownStep] = await enrichStepsWithCliStats(scoped, allUnknown.task.id, [
        { id: allUnknown.step.id },
      ]);
      expect(unknownStep!.tokenUsage).toMatchObject({ outputTokens: null, outputUnknownRuns: 2 });

      const historic = await makeTask('historic zeros');
      await seed(historic, [
        { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
        { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      ]);
      const [zeroCard] = await sumProviderBreakdownWhere(
        scoped,
        eq(schema.tasks.id, historic.task.id),
      );
      expect(zeroCard).toMatchObject({ outputTokens: 0, outputUnknownRuns: 0 });
      const zeroTotals = (await sumTaskTokens(scoped, [historic.task.id])).get(historic.task.id);
      expect(zeroTotals!.outputTokens).toBe(0);
      expect(zeroTotals).not.toHaveProperty('outputUnknownRuns');
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
  });
});
