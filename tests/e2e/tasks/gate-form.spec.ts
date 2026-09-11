import { expect, test } from '@playwright/test';
import { cleanupTaskFixture, cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { readFormValues, seedGate } from '../helpers/gate.js';

/**
 * The gate: a step parked in `waiting_form`, rendered by FormRenderer, answered by a person.
 *
 * This is the product's central interaction — every decision in the workflow is a form like this
 * one — and if submitting breaks, the whole engine stops at its first gate with no error anywhere.
 * Nothing else in the suite covers it: the step specs drive retry and skip, which are recoveries
 * from a step that already ran.
 */

test.describe('gate form', () => {
  test('the parked form renders its fields and its submit label', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let gate = null as Awaited<ReturnType<typeof seedGate>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'gate-render' })).userId;
      gate = await seedGate(sql, userId, 'render');

      await page.goto(`/tasks/${gate.taskId}`);

      await expect(page.getByRole('heading', { name: 'E2E gate' })).toBeVisible();
      await expect(page.getByLabel('Summary')).toBeVisible();
      await expect(page.getByLabel('Proceed')).toBeVisible();
      await expect(page.getByLabel('Mode')).toBeVisible();
      // The schema's own submitLabel, not a generic one — a gate says what it is agreeing to.
      await expect(page.getByRole('button', { name: 'Submit gate' })).toBeVisible();
    } finally {
      if (gate) await cleanupTaskFixture(sql, gate.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('submitting the form stores the answers and closes the wait', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let gate = null as Awaited<ReturnType<typeof seedGate>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'gate-submit' })).userId;
      gate = await seedGate(sql, userId, 'submit');

      await page.goto(`/tasks/${gate.taskId}`);
      await expect(page.getByRole('heading', { name: 'E2E gate' })).toBeVisible();

      await page.getByLabel('Summary').fill('looks right to me');
      await page.getByLabel('Proceed').check();
      await page.getByLabel('Mode').selectOption('fast');
      await page.getByRole('button', { name: 'Submit gate' }).click();

      // The values land in the step's own row, which is what the next step reads. Polled because
      // the write is followed by an enqueue and the page re-fetches.
      await expect
        .poll(async () => (await readFormValues(sql, gate!.stepRowId)) ?? {}, { timeout: 10_000 })
        .toMatchObject({
          [gate.fields.text]: 'looks right to me',
          [gate.fields.checkbox]: true,
          [gate.fields.select]: 'fast',
        });

      // The step's STATUS is deliberately not asserted. Submit writes the values, clears the
      // wait marker, records the event and enqueues ADVANCE_STEP — moving the step is the
      // worker's job, and on a fixture task with no repository that worker fails. What the
      // route guarantees synchronously is below.
      const rows = await sql<{ waiting_started_at: Date | null }[]>`
        select waiting_started_at from task_steps where id = ${gate.stepRowId}
      `;
      expect(rows[0]!.waiting_started_at, 'the wait is closed out').toBeNull();

      const events = await sql<{ event_type: string }[]>`
        select event_type from task_events
        where task_id = ${gate.taskId} and event_type = 'step.form_submitted'
      `;
      expect(events).toHaveLength(1);
    } finally {
      if (gate) await cleanupTaskFixture(sql, gate.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('a required field is enforced before anything is stored', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let gate = null as Awaited<ReturnType<typeof seedGate>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'gate-required' })).userId;
      gate = await seedGate(sql, userId, 'required');

      await page.goto(`/tasks/${gate.taskId}`);
      await expect(page.getByRole('heading', { name: 'E2E gate' })).toBeVisible();

      // Summary is required and left empty on purpose.
      await page.getByRole('button', { name: 'Submit gate' }).click();

      // Nothing was written, and the step is still parked. `required` rejects an ABSENT value,
      // which is the half of that rule worth pinning: a submitted-but-empty value counts as
      // present, so this test uses an untouched field rather than one cleared by hand.
      await expect(page.getByRole('heading', { name: 'E2E gate' })).toBeVisible();
      expect(await readFormValues(sql, gate.stepRowId)).toBeNull();

      const rows = await sql<{ status: string }[]>`
        select status from task_steps where id = ${gate.stepRowId}
      `;
      expect(rows[0]!.status).toBe('waiting_form');
    } finally {
      if (gate) await cleanupTaskFixture(sql, gate.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('the submit route refuses a step that is not parked', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let gate = null as Awaited<ReturnType<typeof seedGate>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'gate-guard' })).userId;
      gate = await seedGate(sql, userId, 'guard');
      await sql`update task_steps set status = 'done' where id = ${gate.stepRowId}`;

      const res = await page.request.post(
        `${API_BASE}/tasks/${gate.taskId}/steps/${gate.stepId}/submit`,
        { data: { values: { summary: 'x' } } },
      );
      // 409 rather than 404: the step exists, it is simply not asking anything.
      expect(res.status()).toBe(409);
      expect((await res.text()).toLowerCase()).toContain('awaiting form');
    } finally {
      if (gate) await cleanupTaskFixture(sql, gate.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
