import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupTaskFixture, cleanupUser, getSql, seedTaskFixture } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { seedSpend } from '../helpers/spend.js';

/**
 * The task page's "Agents, skills and tools used" disclosure, fed by GET /tasks/:id/tool-usage.
 * The endpoint is asserted exactly in tool-usage.spec.ts; this is the page half — that the
 * disclosure is closed by default, fetches when opened, and renders the seeded record.
 */

async function createProvider(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/cli-providers`, {
    data: { name: 'claude-code', label: 'E2E task-panel provider', authMode: 'subscription' },
  });
  expect(res.status(), `provider create failed: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { provider: { id: string } }).provider.id;
}

const OBSERVED = {
  source: 'stream',
  coverage: 'full',
  tools: { Bash: 2, Read: 5 },
  mcp: [{ server: 'haive-rag', tool: 'rag_search', calls: 3 }],
  subagents: [],
  skills: { invoked: [], read: [{ id: 'project-context', reads: 4 }] },
  agents: { assigned: [], read: [{ id: 'code-reviewer', reads: 2 }] },
  loaded: null,
};

test.describe('task page tool usage', () => {
  test('the disclosure renders the seeded usage once opened', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'task-tools' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'task-tools');
      const cliProviderId = await createProvider(page.request);
      await seedSpend(
        sql,
        { taskId: fixture.taskId, taskStepId: fixture.failedStepId, cliProviderId },
        [{ durationMs: 10 * 60_000, costUsd: 0.1, totalTokens: 1_000, toolUsage: OBSERVED }],
      );

      await page.goto(`/tasks/${fixture.taskId}`);
      const summary = page.getByText('Agents, skills and tools used').first();
      await expect(summary).toBeVisible({ timeout: 15_000 });
      // Closed by default: nothing fetched, nothing rendered, until the user asks.
      await expect(page.getByText('code-reviewer (2)')).toHaveCount(0);
      await summary.click();
      await expect(page.getByText('code-reviewer (2)').first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('project-context (4)').first()).toBeVisible();
      await expect(page.getByText('haive-rag/rag_search (3)').first()).toBeVisible();
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
