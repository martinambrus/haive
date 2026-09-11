import { expect, test, type Page } from '@playwright/test';
import { cleanupTaskFixture, cleanupUser, getSql, seedTaskFixture } from '../helpers/db.js';
import { registerUser } from '../helpers/auth.js';
import type postgres from 'postgres';

/**
 * The sidebar's task tree, and the fact that every bit of it is SERVER state.
 *
 * Folder placement, ordering, which groups are closed, the tone filters, the rail's collapsed
 * flag and its width all persist to `user_ui_prefs.settings_json` through a PATCH that merges
 * rather than replaces. None of it touches localStorage — the app layout reads the blob during
 * SSR so the first paint already matches. That design is exactly why these specs reload the page
 * and assert again: a broken PATCH loses the user's filing silently, the UI looks correct until
 * the next visit, and no unit test can see it. `sidebar-tree.ts` already covers the placement
 * RULES; what only a browser can prove is that the rules reach the database and come back.
 */

interface UiPrefs {
  sidebarTree?: {
    folders?: { id: string; name: string }[];
    placements?: Record<string, string>;
    closed?: string[];
    order?: Record<string, number>;
  };
  sidebarFilters?: string[];
  sidebarCollapsed?: boolean;
  sidebarWidthPx?: number;
}

/** The stored blob, as the server has it. `settings_json` is TEXT, so it is parsed here. */
async function readUiPrefs(sql: postgres.Sql, userId: string): Promise<UiPrefs> {
  const rows = await sql<{ settings_json: string }[]>`
    select settings_json from user_ui_prefs where user_id = ${userId}
  `;
  return rows[0] ? (JSON.parse(rows[0].settings_json) as UiPrefs) : {};
}

/** The tree polls every 5s and also fetches on mount, so a seeded task is there on arrival. */
async function gotoWithSidebar(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await expect(page.locator('aside').getByText('ACTIVE TASKS')).toBeVisible();
}

test.describe('sidebar task tree', () => {
  test('a task with no repository is grouped under "No repository"', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'side-group' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'grouped');

      await gotoWithSidebar(page);
      const aside = page.locator('aside');

      // The fixture task carries no repository_id, and the tree gives those their own real
      // group rather than dropping them at the root — it has to be a group so it can be filed
      // like any other.
      await expect(aside.getByRole('button', { name: 'No repository' })).toBeVisible();
      await expect(aside.getByRole('link', { name: /e2e retry\/skip/ })).toBeVisible();
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('a tone filter narrows the list and survives a reload', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'side-filter' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'filter');

      await gotoWithSidebar(page);
      const aside = page.locator('aside');
      const taskRow = aside.getByRole('link', { name: /e2e retry\/skip/ });
      await expect(taskRow).toBeVisible();

      // The fixture task is `failed`, so filtering to RUNNING must hide it. Filters are toggles
      // rather than a radio group, and an empty selection means "show everything".
      await aside.getByRole('button', { name: 'running' }).click();
      await expect(taskRow).toBeHidden();
      await expect(aside.getByRole('button', { name: 'running' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      await expect
        .poll(async () => (await readUiPrefs(sql, userId)).sidebarFilters, { timeout: 5_000 })
        .toEqual(['running']);

      await page.reload();
      await expect(aside.getByRole('button', { name: 'running' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(taskRow).toBeHidden();

      // Turning the last one off returns the list to everything.
      await aside.getByRole('button', { name: 'running' }).click();
      await expect(taskRow).toBeVisible();
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('a folder can be created, renamed and deleted', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'side-folder' })).userId;

      await gotoWithSidebar(page);
      const aside = page.locator('aside');

      // Creating one drops straight into an inline rename, so the folder is never left with a
      // placeholder name nobody chose.
      await aside.getByRole('button', { name: 'New folder' }).click();
      const nameField = aside.getByRole('textbox');
      await expect(nameField).toBeFocused();
      await nameField.fill('Inbox');
      await nameField.press('Enter');

      await expect(aside.getByRole('button', { name: /^Inbox/ })).toBeVisible();
      await expect
        .poll(async () => (await readUiPrefs(sql, userId)).sidebarTree?.folders?.length, {
          timeout: 5_000,
        })
        .toBe(1);

      await page.reload();
      await expect(aside.getByRole('button', { name: /^Inbox/ })).toBeVisible();

      // Rename and Delete live in a `hidden … group-hover/folder:flex` span, so they are not in
      // the layout at all until the row is hovered — `display: none`, not merely invisible.
      // Anchored, not exact: the row's accessible name carries its task COUNT ("Inbox 0"),
      // so `exact` matches nothing — while a bare name also matches the "Rename Inbox" and
      // "Delete Inbox" that hovering reveals. `/^Inbox/` is the one form that means the row.
      await aside.getByRole('button', { name: /^Inbox/ }).hover();
      await aside.getByRole('button', { name: 'Rename Inbox' }).click();
      const renameField = aside.getByRole('textbox');
      await renameField.fill('Later');
      await renameField.press('Enter');
      await expect(aside.getByRole('button', { name: /^Later/ })).toBeVisible();

      // No confirmation by design: a folder holds no state of its own, and deleting one moves
      // its contents up rather than removing them.
      await aside.getByRole('button', { name: /^Later/ }).hover();
      await aside.getByRole('button', { name: 'Delete Later' }).click();
      await expect(aside.getByRole('button', { name: /^Later/ })).toHaveCount(0);
      await expect
        .poll(async () => (await readUiPrefs(sql, userId)).sidebarTree?.folders?.length ?? 0, {
          timeout: 5_000,
        })
        .toBe(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('collapse all hides the tasks and expand all brings them back', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'side-collapse' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'collapse');

      await gotoWithSidebar(page);
      const aside = page.locator('aside');
      const taskRow = aside.getByRole('link', { name: /e2e retry\/skip/ });
      await expect(taskRow).toBeVisible();

      await aside.getByRole('button', { name: 'Collapse all folders' }).click();
      await expect(taskRow).toBeHidden();
      // Closed rather than open is what is stored, so a repository appearing later arrives
      // expanded instead of inheriting someone else's collapse.
      await expect
        .poll(async () => (await readUiPrefs(sql, userId)).sidebarTree?.closed?.length ?? 0, {
          timeout: 5_000,
        })
        .toBeGreaterThan(0);

      await aside.getByRole('button', { name: 'Expand all folders' }).click();
      await expect(taskRow).toBeVisible();
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('the rail stays collapsed across a reload', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'side-rail' })).userId;

      await gotoWithSidebar(page);
      const aside = page.locator('aside');

      await aside.getByRole('button', { name: 'Collapse sidebar' }).click();
      // The task tree is UNMOUNTED while collapsed, which is what stops a collapsed rail from
      // polling /tasks every five seconds.
      await expect(aside.getByText('ACTIVE TASKS')).toBeHidden();
      await expect(aside.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );

      await expect
        .poll(async () => (await readUiPrefs(sql, userId)).sidebarCollapsed, { timeout: 5_000 })
        .toBe(true);

      await page.reload();
      await expect(aside.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
      await expect(aside.getByText('ACTIVE TASKS')).toBeHidden();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('the rail width survives a reload', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'side-width' })).userId;

      await gotoWithSidebar(page);
      const aside = page.locator('aside');
      const before = (await aside.boundingBox())!.width;

      // The divider is a pointer-event drag, and the width is committed once on release — not
      // on every move — so this is one drag rather than a stream of writes.
      const handle = page.getByRole('separator', { name: 'Resize sidebar' });
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(before + 80, box.y + box.height / 2, { steps: 10 });
      await page.mouse.up();

      await expect
        .poll(async () => (await readUiPrefs(sql, userId)).sidebarWidthPx, { timeout: 5_000 })
        .toBeGreaterThan(before);

      await page.reload();
      // Asserted as "wider than it was" rather than an exact number: the value is clamped
      // between the rail's minimum and maximum and rounded on the way in, so pinning a pixel
      // count would be testing the clamp's arithmetic, which has its own unit tests.
      const after = (await page.locator('aside').boundingBox())!.width;
      expect(after - before).toBeGreaterThan(40);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('a task dragged into a folder is filed there, and dropping it on the root un-files it', async ({
    page,
  }) => {
    const sql = getSql();
    let userId = '';
    let fixture = null as Awaited<ReturnType<typeof seedTaskFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'side-drag' })).userId;
      fixture = await seedTaskFixture(sql, userId, 'drag');

      await gotoWithSidebar(page);
      const aside = page.locator('aside');

      await aside.getByRole('button', { name: 'New folder' }).click();
      const nameField = aside.getByRole('textbox');
      await nameField.fill('Filed');
      await nameField.press('Enter');
      await expect(aside.getByRole('button', { name: /^Filed/ })).toBeVisible();

      // Into the MIDDLE of the folder row: the outer bands mean "place before/after me among
      // my siblings", and only the middle means "put it inside".
      const taskRow = aside.getByRole('link', { name: /e2e retry\/skip/ });
      await taskRow.dragTo(aside.getByRole('button', { name: /^Filed/ }));

      await expect
        .poll(
          async () => {
            const placements = (await readUiPrefs(sql, userId)).sidebarTree?.placements ?? {};
            return Object.keys(placements).length;
          },
          { timeout: 5_000 },
        )
        .toBe(1);

      await page.reload();
      // Still filed after a round trip: the placement came back from the server, which is the
      // whole point — the tree is rebuilt from the blob on every load.
      await expect(aside.getByRole('button', { name: /^Filed/ })).toBeVisible();
      await expect(aside.getByRole('link', { name: /e2e retry\/skip/ })).toBeVisible();
      await expect
        .poll(async () =>
          Object.keys((await readUiPrefs(sql, userId)).sidebarTree?.placements ?? {}),
        )
        .toHaveLength(1);

      // The un-file path (dropping on the tree's background restores the default placement
      // rather than recording "root") is left to sidebar-tree.test.ts, which owns the placement
      // RULES. What needed a browser is that a drag reaches the server at all.
    } finally {
      if (fixture) await cleanupTaskFixture(sql, fixture.taskId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
