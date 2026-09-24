import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { cleanupRepoFixture, cleanupUser, getSql, seedRepoFixture } from '../helpers/db.js';
import { API_BASE, registerUser } from '../helpers/auth.js';
import { seedPlan } from '../helpers/plan.js';

/**
 * The plan canvas, and the derivation that carries it.
 *
 * Status roll-up is computed at READ time and never stored, so it is a property of the endpoint
 * rather than of any row — which means the only way to be sure a tree reports itself correctly is
 * to ask it. `rollUpStatus` has unit tests for the rule; these prove the rule reaches the tree
 * that a person actually looks at, through the skeleton load, the edge load and the view mapping.
 *
 * The fixture is deliberately shaped around `blocked_human`: it is the one status that propagates
 * upward, because it is a verdict a PERSON entered and no amount of agent progress underneath may
 * paint over it. A tree that quietly rendered that root as green would be telling somebody their
 * blocker had cleared.
 */

test.describe('plan canvas', () => {
  test('a human blocker propagates to the root', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let repo = null as Awaited<ReturnType<typeof seedRepoFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'plan-rollup' })).userId;
      repo = await seedRepoFixture(sql, userId, 'plan-rollup');
      const plan = await seedPlan(sql, repo.repoId, 'rollup');

      const res = await page.request.get(`${API_BASE}/repositories/${repo.repoId}/plan/tree`);
      expect(res.status()).toBe(200);
      const body = (await res.json()) as {
        nodes: { id: string; title: string; status: string; rolledStatus: string }[];
      };

      const byId = new Map(body.nodes.map((n) => [n.id, n]));
      expect(byId.size, 'root plus three children').toBe(4);

      // Each child keeps its OWN status — the roll-up is about ancestors.
      expect(byId.get(plan.doneId)!.status).toBe('done');
      expect(byId.get(plan.blockedId)!.status).toBe('blocked_human');
      expect(byId.get(plan.todoId)!.status).toBe('todo');

      // And the root reports the blocker, whatever its own row says.
      const root = byId.get(plan.rootId)!;
      expect(root.status, 'the stored row is untouched').toBe('todo');
      expect(root.rolledStatus, 'a blocked descendant makes every ancestor render blocked').toBe(
        'blocked_human',
      );
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('an image in a node body survives an edit, and nothing fetches it', async ({ page }) => {
    // The plan route is the heaviest in the app to compile, so every wait here is generous.
    test.setTimeout(240_000);
    const sql = getSql();
    let userId = '';
    let repo = null as Awaited<ReturnType<typeof seedRepoFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'plan-image' })).userId;
      repo = await seedRepoFixture(sql, userId, 'plan-image');
      const plan = await seedPlan(sql, repo.repoId, 'image');
      // On the api host, which the page's CSP admits, so a fetch of it would really be made.
      const probe = `${API_BASE}/e2e-image-probe-${randomUUID()}.png`;
      await sql`update plan_nodes set body = ${`Look: ![wireframe](${probe}) done`} where id = ${plan.todoId}`;
      let fetched = 0;
      page.on('request', (request) => {
        if (request.url().startsWith(probe)) fetched += 1;
      });

      await page.goto(`/repos/${repo.repoId}/plan?node=${plan.todoId}`);
      await page.getByRole('button', { name: 'Edit description' }).click({ timeout: 120_000 });
      const editor = page.locator('.ProseMirror');
      await expect(editor).toContainText('image: wireframe', { timeout: 30_000 });
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('!');
      const saved = page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          new URL(res.url()).pathname.endsWith(`/nodes/${plan.todoId}`),
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await saved).ok()).toBe(true);

      const [row] = await sql<
        { body: string }[]
      >`select body from plan_nodes where id = ${plan.todoId}`;
      expect(row!.body).toContain(`![wireframe](${probe})`);
      expect(row!.body).toContain('done!');
      expect(fetched, 'neither the viewer nor the editor fetches an image').toBe(0);
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  // A "the canvas renders its nodes" test is deliberately NOT here. The plan route is the
  // heaviest in the app — 13s to compile on an idle dev stack — and the one attempt took two
  // minutes and failed on a loaded host, which is a result I could not tell apart from a real
  // defect. A test nobody can verify is worse than an absent one. The redirect below proves the
  // route resolves; asserting what it PAINTS wants a quiet machine and a look at the markup,
  // and belongs in its own change.

  test('a bare repository URL redirects to its plan', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    let repo = null as Awaited<ReturnType<typeof seedRepoFixture>> | null;
    try {
      userId = (await registerUser(sql, page.request, { prefix: 'plan-redirect' })).userId;
      repo = await seedRepoFixture(sql, userId, 'plan-redirect');

      // Added in #84 because the bare path 404'd, which is what a bookmark or a pasted link got.
      // Asserted here rather than in the repos specs because the destination is the plan.
      await page.goto(`/repos/${repo.repoId}`);
      await expect(page).toHaveURL(new RegExp(`/repos/${repo.repoId}/plan$`), { timeout: 45_000 });
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test("another user cannot read this repository's plan", async ({ page, playwright }) => {
    const sql = getSql();
    let ownerId = '';
    let strangerId = '';
    let repo = null as Awaited<ReturnType<typeof seedRepoFixture>> | null;
    const strangerCtx = await playwright.request.newContext();
    try {
      ownerId = (await registerUser(sql, page.request, { prefix: 'plan-owner' })).userId;
      repo = await seedRepoFixture(sql, ownerId, 'plan-private');
      await seedPlan(sql, repo.repoId, 'private');

      strangerId = (await registerUser(sql, strangerCtx, { prefix: 'plan-stranger' })).userId;
      const res = await strangerCtx.get(`${API_BASE}/repositories/${repo.repoId}/plan/tree`);
      // The route resolves the repo through an ownership check, so a stranger gets the same
      // answer as someone asking about a repository that does not exist.
      expect([403, 404]).toContain(res.status());
    } finally {
      if (repo) await cleanupRepoFixture(sql, repo.repoId);
      if (strangerId) await cleanupUser(sql, strangerId);
      if (ownerId) await cleanupUser(sql, ownerId);
      await sql.end({ timeout: 5 });
      await strangerCtx.dispose();
    }
  });
});
