import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { cleanupUser, getSql } from '../helpers/db.js';

test('a step query opens saved readable results, can be rerun, and handles legacy results', async ({
  page,
  browser,
}) => {
  const sql = getSql();
  const otherContext = await browser.newContext();
  const users: string[] = [];
  try {
    const user = await registerUser(sql, page.request, { prefix: 'rag-playground' });
    users.push(user.userId);
    const other = await registerUser(sql, otherContext.request, { prefix: 'rag-other' });
    users.push(other.userId);
    const taskId = randomUUID();
    const stepId = randomUUID();
    const queryId = randomUUID();
    const legacyId = randomUUID();
    const at = new Date();
    await sql`insert into tasks (id, user_id, type, title, status, completed_at)
      values (${taskId}, ${user.userId}, 'workflow', 'RAG playground fixture', 'completed', ${at})`;
    await sql`insert into task_steps (id, task_id, step_id, step_index, title, status, started_at, ended_at)
      values (${stepId}, ${taskId}, '07-phase-2-implement', 7, 'Implement', 'done', ${new Date(at.getTime() - 5000)}, ${at})`;
    await sql`insert into cli_invocations (task_id, task_step_id, mode, prompt, started_at, ended_at, exit_code)
      values (${taskId}, ${stepId}, 'cli', 'Fixture', ${new Date(at.getTime() - 5000)}, ${at}, 0)`;
    const hits = [
      {
        sourcePath: 'src/session.ts',
        sectionId: '',
        scope: 'local',
        rrf: 0.05,
        denseSim: 0.8,
        content: '**Original cookie implementation**\n\nHuman-readable evidence.',
      },
    ];
    const assessment = {
      status: 'used',
      reason: 'The agent used the returned cookie implementation.',
      evidence: [],
      assessedAt: at.toISOString(),
    };
    await sql`insert into rag_query_log (id, task_id, query, top_k, hit_count, result_hits, usage_assessment, created_at)
      values (${queryId}, ${taskId}, 'session cookie implementation', 5, 1, ${sql.json(hits)}, ${sql.json(assessment)}, ${new Date(at.getTime() - 1000)})`;
    await sql`insert into rag_query_log (id, task_id, query, hit_count, created_at)
      values (${legacyId}, ${taskId}, 'legacy cookie query', 1, ${new Date(at.getTime() - 2000)})`;

    // A real user session cannot read the other user's saved snippets, history, or retrieval context.
    for (const path of [`/queries/${queryId}`, `/tasks/${taskId}/queries`]) {
      expect((await otherContext.request.get(`${API_BASE}/rag/playground${path}`)).status()).toBe(
        404,
      );
    }
    expect(
      (
        await otherContext.request.post(`${API_BASE}/rag/playground/search`, {
          data: { taskId, query: 'cookies' },
        })
      ).status(),
    ).toBe(404);

    await page.goto(`/tasks/${taskId}`);
    await page.getByRole('button', { name: 'Show RAG stats', exact: true }).click();
    const queryLink = page.getByRole('link', {
      name: 'session cookie implementation',
      exact: true,
    });
    await expect(queryLink.locator('xpath=ancestor::tr')).toHaveClass(/bg-emerald-500\/10/);
    await expect(queryLink.locator('xpath=ancestor::tr')).toContainText('Used');
    await queryLink.click();
    await expect(page).toHaveURL(new RegExp(`/settings/rag-playground\\?queryId=${queryId}$`));
    await expect(page.getByLabel('Query', { exact: true })).toHaveValue(
      'session cookie implementation',
    );
    await expect(page.getByLabel('Max results')).toHaveValue('5');
    await expect(
      page.getByRole('heading', { name: 'Original agent results · 1 hits' }),
    ).toBeVisible();
    await expect(page.getByText('Original cookie implementation', { exact: true })).toBeVisible();
    await expect(page.getByText('Human-readable evidence.', { exact: true })).toBeVisible();

    // Stub just the expensive retrieval, exercising the real form and result rendering.
    let requestBody: unknown;
    await page.route('**/rag/playground/search', async (route) => {
      requestBody = route.request().postDataJSON();
      await route.fulfill({ json: { hits: [], text: '' } });
    });
    await page.getByRole('button', { name: 'Run query', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Current results · 0 hits' })).toBeVisible();
    expect(requestBody).toEqual({ taskId, query: 'session cookie implementation', top_k: 5 });
    await expect(page.getByText('No RAG hits.', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Original agent results · 1 hits' }),
    ).toBeVisible();
    expect(
      (await sql`select count(*)::int as n from rag_query_log where task_id = ${taskId}`)[0]!.n,
    ).toBe(2);

    await page.getByRole('link', { name: /legacy cookie query/ }).click();
    await expect(page.getByLabel('Query', { exact: true })).toHaveValue('legacy cookie query');
    await expect(page.getByText(/Original results were not saved/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Current results · 0 hits' })).toHaveCount(0);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await otherContext.close();
    for (const id of users) await cleanupUser(sql, id);
    await sql.end({ timeout: 5 });
  }
});
