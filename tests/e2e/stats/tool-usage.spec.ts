import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupTaskFixture, cleanupUser, getSql, seedTaskFixture } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { seedSpend } from '../helpers/spend.js';

/**
 * What /stats/tool-usage and /tasks/:id/tool-usage report, from rows whose records are known
 * in advance.
 *
 * The tally itself has unit tests in the worker and the per-step merge in `@haive/shared/stats`.
 * What only a live stack can exercise is the SQL between a jsonb record and a figure: the
 * LATERAL reads that must not throw on a `loaded` that is a JSON null, the coverage buckets that
 * decide which rows enter which denominator, the attribution fold that puts a run under its step,
 * and the join that scopes it all to one user.
 */

async function createProvider(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/cli-providers`, {
    data: { name: 'claude-code', label: 'E2E tool-usage provider', authMode: 'subscription' },
  });
  expect(res.status(), `provider create failed: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { provider: { id: string } }).provider.id;
}

/** A fully observable record in the exact shape the worker writes. */
const OBSERVED = {
  source: 'stream',
  coverage: 'full',
  tools: { Bash: 2, Read: 5 },
  mcp: [{ server: 'haive-rag', tool: 'rag_search', calls: 3 }],
  subagents: [{ type: 'Explore', calls: 1 }],
  skills: { invoked: [{ id: 'dataviz', calls: 1 }], read: [] },
  agents: { assigned: [], read: [{ id: 'code-reviewer', reads: 2 }] },
  loaded: {
    agents: ['claude', 'code-reviewer'],
    skills: ['dataviz'],
    mcpServers: ['filesystem', 'haive-rag'],
    toolCount: 20,
  },
};

/** A run whose format carries no tool events: every list empty, and `loaded` a JSON null — the
 *  value the LATERAL reads must be guarded against. */
const UNOBSERVABLE = {
  source: 'backfill',
  coverage: 'none',
  tools: {},
  mcp: [],
  subagents: [],
  skills: { invoked: [], read: [] },
  agents: { assigned: [], read: [] },
  loaded: null,
};

interface Capped<T> {
  rows: T[];
  count: number;
  truncated: boolean;
}

interface ToolUsageStats {
  coverage: {
    total: number;
    recorded: number;
    observable: number;
    partial: number;
    unobservable: number;
    unrecorded: number;
    withLoaded: number;
    assignedRecordedSince: string | null;
  };
  personas: {
    assigned: Capped<{ id: string }>;
    read: Capped<{ id: string; reads: number; runs: number }>;
  };
  skills: { invoked: Capped<{ id: string; calls: number }> };
  mcp: {
    servers: Capped<{
      server: string;
      haive: boolean;
      offeredRuns: number;
      calledRuns: number;
      calls: number;
    }>;
    tools: Capped<{ server: string; tool: string; calls: number }>;
  };
  subagents: Capped<{ type: string; calls: number }>;
  nativeTools: Capped<{ tool: string; calls: number }>;
  unused: null | { available: boolean; reason?: string };
}

interface TaskToolUsage {
  steps: Array<{
    stepRowId: string;
    usage: null | {
      runs: number;
      observable: number;
      toolCalls: number;
      personasRead: Array<{ id: string; n: number }>;
    };
  }>;
  totals: {
    runs: number;
    observable: number;
    unobservable: number;
    unrecorded: number;
    toolCalls: number;
    mcp: Array<{ server: string; tool: string; calls: number }>;
  };
  coverage: { total: number; observable: number; unobservable: number; unrecorded: number };
}

test.describe('tool-usage statistics', () => {
  test('counts observable runs only, and never throws on an unobservable one', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'stats-tools' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'stats-tools');
      const cliProviderId = await createProvider(page.request);
      await seedSpend(
        sql,
        { taskId: fixture.taskId, taskStepId: fixture.failedStepId, cliProviderId },
        [
          { durationMs: 10 * 60_000, costUsd: 0.1, totalTokens: 1_000, toolUsage: OBSERVED },
          { durationMs: 10 * 60_000, costUsd: 0.1, totalTokens: 1_000, toolUsage: UNOBSERVABLE },
          { durationMs: 10 * 60_000, costUsd: 0.1, totalTokens: 1_000 },
        ],
      );

      const res = await page.request.get(`${API_BASE}/stats/tool-usage`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as ToolUsageStats;

      // Three buckets, three rows: the NULL one is unrecorded, the `none` one unobservable, and
      // only the full one enters any list below.
      expect(body.coverage).toMatchObject({
        total: 3,
        recorded: 2,
        observable: 1,
        partial: 0,
        unobservable: 1,
        unrecorded: 1,
        withLoaded: 1,
        assignedRecordedSince: null,
      });
      expect(body.personas.assigned.rows).toEqual([]);
      expect(body.personas.read.rows).toMatchObject([{ id: 'code-reviewer', reads: 2, runs: 1 }]);
      expect(body.skills.invoked.rows).toMatchObject([{ id: 'dataviz', calls: 1 }]);
      expect(body.mcp.tools.rows).toMatchObject([
        { server: 'haive-rag', tool: 'rag_search', calls: 3 },
      ]);
      // Offered ∪ called: filesystem was wired and never called, haive-rag wired and called.
      const servers = Object.fromEntries(body.mcp.servers.rows.map((r) => [r.server, r]));
      expect(servers.filesystem).toMatchObject({
        haive: true,
        offeredRuns: 1,
        calledRuns: 0,
        calls: 0,
      });
      expect(servers['haive-rag']).toMatchObject({
        haive: true,
        offeredRuns: 1,
        calledRuns: 1,
        calls: 3,
      });
      expect(body.subagents.rows).toMatchObject([{ type: 'Explore', calls: 1 }]);
      // Native tools never carry an MCP key; the MCP calls live in `mcp` alone.
      expect(body.nativeTools.rows.map((r) => r.tool).sort()).toEqual(['Bash', 'Read']);
      expect(body.unused).toBeNull();

      // The unused report is keyed on a repository facet being PRESENT; until the on-disk
      // inventory scan ships it answers unavailable, and never a 404.
      const withRepo = await page.request.get(
        `${API_BASE}/stats/tool-usage?repositoryId=${randomUUID()}`,
      );
      expect(withRepo.status()).toBe(200);
      expect(((await withRepo.json()) as ToolUsageStats).unused).toMatchObject({
        available: false,
        reason: 'scan-unavailable',
      });

      const perTask = await page.request.get(`${API_BASE}/tasks/${fixture.taskId}/tool-usage`);
      expect(perTask.status()).toBe(200);
      const task = (await perTask.json()) as TaskToolUsage;
      const seededStep = task.steps.find((s) => s.stepRowId === fixture!.failedStepId);
      expect(seededStep?.usage).toMatchObject({ runs: 3, observable: 1, toolCalls: 7 });
      expect(seededStep?.usage?.personasRead).toEqual([{ id: 'code-reviewer', n: 2 }]);
      // A step with no attributed run is a dash, never a row of zeros.
      expect(
        task.steps.some((s) => s.stepRowId !== fixture!.failedStepId && s.usage === null),
      ).toBe(true);
      expect(task.totals).toMatchObject({
        runs: 3,
        observable: 1,
        unobservable: 1,
        unrecorded: 1,
        toolCalls: 7,
      });
      expect(task.totals.mcp).toEqual([{ server: 'haive-rag', tool: 'rag_search', calls: 3 }]);
      expect(task.coverage).toEqual({
        total: 3,
        observable: 1,
        partial: 0,
        unobservable: 1,
        unrecorded: 1,
      });
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('the tab renders the seeded usage', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'tools-page' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'tools-render');
      const cliProviderId = await createProvider(page.request);
      await seedSpend(
        sql,
        { taskId: fixture.taskId, taskStepId: fixture.failedStepId, cliProviderId },
        [{ durationMs: 10 * 60_000, costUsd: 0.1, totalTokens: 1_000, toolUsage: OBSERVED }],
      );

      await page.goto('/stats?tab=tools');
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      // The page resolves its zone and clock on the client and gates the first fetch on them,
      // so the figures land a beat after the heading (see summary.spec.ts).
      await expect(page.getByText('code-reviewer').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('haive-rag/rag_search').first()).toBeVisible();
      // No repository selected: the unused card asks for one instead of reporting.
      await expect(page.getByText(/Select a repository above/).first()).toBeVisible();
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
      ownerId = (await registerUser(sql, page.request, { prefix: 'tools-owner' })).userId;
      fixture = await seedTaskFixture(sql, ownerId, 'tools-private');
      const ownerProvider = await createProvider(page.request);
      await seedSpend(
        sql,
        { taskId: fixture.taskId, taskStepId: fixture.failedStepId, cliProviderId: ownerProvider },
        [{ durationMs: 5 * 60_000, costUsd: 0.5, totalTokens: 5_000, toolUsage: OBSERVED }],
      );

      strangerId = (await registerUser(sql, strangerCtx, { prefix: 'tools-stranger' })).userId;
      const stats = await strangerCtx.get(`${API_BASE}/stats/tool-usage`);
      expect(stats.status()).toBe(200);
      const body = (await stats.json()) as ToolUsageStats;
      expect(body.coverage.total).toBe(0);
      expect(body.personas.read.rows).toEqual([]);
      expect(body.mcp.tools.rows).toEqual([]);

      const task = await strangerCtx.get(`${API_BASE}/tasks/${fixture.taskId}/tool-usage`);
      expect(task.status()).toBe(404);
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (strangerId) await cleanupUser(sql, strangerId);
      if (ownerId) await cleanupUser(sql, ownerId);
      await sql.end({ timeout: 5 });
      await strangerCtx.dispose();
    }
  });
});
