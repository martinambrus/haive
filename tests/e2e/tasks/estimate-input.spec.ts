import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  cleanupRepoFixture,
  cleanupTaskFixture,
  cleanupUser,
  getSql,
  seedRepoFixture,
} from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';
import { seedGate } from '../helpers/gate.js';

test('new-task estimates use hours and minutes and preserve the submitted duration', async ({
  page,
}) => {
  const sql = getSql();
  let userId = '';
  let repo: Awaited<ReturnType<typeof seedRepoFixture>> | null = null;
  try {
    userId = (await registerUser(sql, page.request, { prefix: 'estimate-input' })).userId;
    repo = await seedRepoFixture(sql, userId, 'estimate-input');
    const requests: Record<string, unknown>[] = [];
    // Capture the real browser submission without starting a workflow on the fixture repo.
    await page.route(
      (url) => url.pathname === '/tasks',
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        requests.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({ status: 400, json: { error: 'Submission captured by test' } });
      },
    );
    await page.goto(`/tasks/new?repositoryId=${repo.repoId}`);
    await page.getByLabel('Title', { exact: true }).fill('Estimate input check');
    await page.getByLabel(/Description/).fill('Verify the duration input.');
    const hours = page.getByRole('spinbutton', { name: 'Estimated time: hours', exact: true });
    const minutes = page.getByRole('spinbutton', { name: 'Estimated time: minutes', exact: true });
    for (const [h, m, expected] of [
      ['0', '35', 35 / 60],
      ['1', '35', 1 + 35 / 60],
      ['', '21', 0.35],
      ['0', '35.5', 35.5 / 60],
      ['0', '90', 1.5],
      ['', '', undefined],
    ] as const) {
      await hours.fill(h);
      await minutes.fill(m);
      const previousCount = requests.length;
      await page.getByRole('button', { name: /Create task/i }).click();
      await expect.poll(() => requests.length).toBe(previousCount + 1);
      expect(requests.at(-1)?.estimatedTimeHours).toBe(expected);
      if (expected === undefined) expect(requests.at(-1)).not.toHaveProperty('estimatedTimeHours');
    }

    for (const [h, m] of [
      ['-1', '35'],
      ['0', '-1'],
      ['0', '0'],
      ['1000', '1'],
    ]) {
      await hours.fill(h!);
      await minutes.fill(m!);
      const previousCount = requests.length;
      await page.getByRole('button', { name: /Create task/i }).click();
      expect(
        await page.locator('form').evaluate((form: HTMLFormElement) => form.checkValidity()),
      ).toBe(false);
      expect(requests).toHaveLength(previousCount);
    }
  } finally {
    if (repo) await cleanupRepoFixture(sql, repo.repoId);
    if (userId) await cleanupUser(sql, userId);
    await sql.end({ timeout: 5 });
  }
});

for (const legacy of [false, true]) {
  test(`estimate confirmation shows hours and minutes (${legacy ? 'persisted legacy' : 'declared unit'})`, async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    let gate: Awaited<ReturnType<typeof seedGate>> | null = null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'estimate-gate' })).userId;
      gate = await seedGate(sql, userId, randomUUID());
      const form = {
        title: 'Confirm estimate',
        fields: [
          {
            type: 'number',
            id: 'estimatedHours',
            label: 'Estimated effort',
            ...(legacy ? {} : { unit: 'hours' }),
            default: 0.35,
            min: 0.05,
            max: 1000,
            step: 'any',
            required: true,
          },
        ],
        submitLabel: 'Confirm estimate',
      };
      await sql`update task_steps set form_schema = ${sql.json(form)} where id = ${gate.stepRowId}`;
      let submitted: Record<string, unknown> | null = null;
      await page.route(
        (url) => url.pathname.endsWith(`/steps/${gate!.stepId}/submit`),
        async (route) => {
          submitted = route.request().postDataJSON() as Record<string, unknown>;
          await route.fulfill({ status: 400, json: { error: 'Submission captured by test' } });
        },
      );
      await page.goto(`/tasks/${gate.taskId}`);
      const hours = page.getByRole('spinbutton', { name: 'Estimated effort: hours', exact: true });
      const minutes = page.getByRole('spinbutton', {
        name: 'Estimated effort: minutes',
        exact: true,
      });
      await expect(hours).toHaveValue('0');
      await expect(minutes).toHaveValue('21');
      await minutes.fill('35');
      await page.getByRole('button', { name: 'Confirm estimate', exact: true }).click();
      await expect.poll(() => submitted).toEqual({ values: { estimatedHours: 35 / 60 } });
      await expect(hours).toHaveValue('0');
      await expect(minutes).toHaveValue('35');
    } finally {
      if (gate) await cleanupTaskFixture(sql, gate.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
}
