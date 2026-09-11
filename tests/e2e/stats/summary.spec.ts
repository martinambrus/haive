import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupTaskFixture, cleanupUser, getSql, seedTaskFixture } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { seedSpend } from '../helpers/spend.js';

/**
 * What /stats reports, from rows whose totals are known in advance.
 *
 * The maths already has unit tests — computeBusySpan, buildTaskTimeBreakdown, normalizeTokens and
 * friends all live in `@haive/shared/stats` with their own suites. These assert the layer between
 * a row and a figure: the predicate that decides which invocations count, the join that scopes
 * them to one user, the cost rule's reading of the `cost` blob, and the page actually displaying
 * what the endpoint returned. That layer is where a wrong join shows somebody the wrong money.
 *
 * Both halves are asserted deliberately — the endpoint exactly, the page loosely. The endpoint is
 * where the arithmetic must be exact; the page is where it must ARRIVE, and pinning its formatting
 * to the digit would be testing a formatter that has its own tests.
 */

/** A provider row, made through the API so every column the product defaults is defaulted. */
async function createProvider(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/cli-providers`, {
    data: { name: 'claude-code', label: 'E2E stats provider', authMode: 'subscription' },
  });
  expect(res.status(), `provider create failed: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { provider: { id: string } }).provider.id;
}

test.describe('statistics', () => {
  test('spend, tokens and invocations are summed from the seeded rows', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'stats-spend' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'stats');

      // 1.25 USD over two runs, 90 minutes of agent time, 30k tokens. Chosen so every figure is
      // distinctive enough to find on a page that renders a lot of zeros.
      const cliProviderId = await createProvider(page.request);
      const seeded = await seedSpend(
        sql,
        { taskId: fixture.taskId, taskStepId: fixture.failedStepId, cliProviderId },
        [
          { durationMs: 60 * 60_000, costUsd: 1.0, totalTokens: 20_000 },
          { durationMs: 30 * 60_000, costUsd: 0.25, totalTokens: 10_000 },
        ],
      );

      const res = await page.request.get(`${API_BASE}/stats/summary`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        spend: { realUsd: number; invocations: number };
        tokens: { totalTokens: number };
        time: { agentMs: number };
      };

      expect(body.spend.invocations, 'both seeded runs are counted').toBe(2);
      // Floating point: the rule sums numerics and hands back a double.
      expect(body.spend.realUsd).toBeCloseTo(seeded.totalCostUsd, 2);
      expect(body.tokens.totalTokens).toBe(seeded.totalTokens);
      // Summed from the TIMESTAMPS, which is how every agent-hours figure in the product is
      // defined — rows carrying a null duration_ms still count.
      expect(body.time.agentMs).toBe(seeded.totalMs);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('another user sees none of it', async ({ page, playwright }) => {
    const sql = getSql();
    let ownerId = '';
    let strangerId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    const strangerCtx = await playwright.request.newContext();
    try {
      ownerId = (await registerUser(sql, page.request, { prefix: 'stats-owner' })).userId;
      fixture = await seedTaskFixture(sql, ownerId, 'stats-private');
      const ownerProvider = await createProvider(page.request);
      await seedSpend(
        sql,
        { taskId: fixture.taskId, taskStepId: fixture.failedStepId, cliProviderId: ownerProvider },
        [{ durationMs: 45 * 60_000, costUsd: 3.5, totalTokens: 50_000 }],
      );

      // The scoping is a join predicate rather than a filter applied afterwards, so it is worth
      // an assertion of its own: a stats page that leaked across accounts would leak spend.
      strangerId = (await registerUser(sql, strangerCtx, { prefix: 'stats-stranger' })).userId;
      const res = await strangerCtx.get(`${API_BASE}/stats/summary`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        spend: { realUsd: number; invocations: number };
        time: { agentMs: number };
      };
      expect(body.spend.invocations).toBe(0);
      expect(body.spend.realUsd).toBe(0);
      expect(body.time.agentMs).toBe(0);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (strangerId) await cleanupUser(sql, strangerId);
      if (ownerId) await cleanupUser(sql, ownerId);
      await sql.end({ timeout: 5 });
      await strangerCtx.dispose();
    }
  });

  test('the page renders the seeded spend', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'stats-page' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'stats-render');
      const cliProviderId = await createProvider(page.request);
      await seedSpend(
        sql,
        { taskId: fixture.taskId, taskStepId: fixture.failedStepId, cliProviderId },
        [{ durationMs: 20 * 60_000, costUsd: 4.2, totalTokens: 12_345 }],
      );

      await page.goto('/stats');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

      // The page resolves its time zone and relative-preset clock on the CLIENT and leaves both
      // null until then, gating the first fetch — so the figure arrives a beat after the heading
      // and a plain toBeVisible on load would race it.
      await expect(page.getByText(/4\.20/).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
