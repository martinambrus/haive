import { API_BASE } from '../helpers/auth.js';
import { expect, test } from '../helpers/fixtures.js';
import { holdScripts, reactAttached, waitForReact } from '../helpers/hydration.js';

const API_ORIGIN = new URL(API_BASE).origin;

/**
 * A submit before React attaches NewRepoForm's handler is the browser's own. The fields have names
 * now, so without `method="post"` on the form that is a GET, which puts the display name, branch and
 * writable choice in the URL, the history and every access log. Turning JavaScript off stands in
 * for that window: the page is the server-rendered HTML and nothing ever attaches. It is submitted
 * twice, by its button and by Enter in the Display name field, and the name must appear in no
 * navigation.
 */
test.describe('/repos/new submitted before React attaches its handler', () => {
  test.use({ javaScriptEnabled: false });

  for (const via of ['the button', 'Enter in the Display name field'] as const) {
    test(`submitting with ${via} keeps the typed name out of the URL`, async ({ page, users }) => {
      await users.register(page.request, { prefix: 'repo-prehydrate-submit' });
      const typed = `prehydrate-${Date.now().toString(36)}`;
      const navigations: Array<{ method: string; url: string }> = [];
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          navigations.push({ method: request.method(), url: request.url() });
        }
      });

      await page.goto('/repos/new');
      await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();
      const started = page.url();

      await page.getByLabel('Display name').fill(typed);
      if (via === 'the button') {
        await page.getByRole('button', { name: 'Create repository' }).click();
      } else {
        await page.getByLabel('Display name').press('Enter');
      }
      await page.waitForLoadState('load');

      const secrets = [typed, 'repoName='];
      const leaked = [...navigations.map((navigation) => navigation.url), page.url()].filter(
        (url) => secrets.some((secret) => url.includes(secret)),
      );
      expect(leaked).toEqual([]);
      expect(navigations.at(-1)?.method).toBe('POST');
      expect(page.url()).toBe(started);
      await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();
    });
  }
});

/**
 * The same window with JavaScript on. The page's script chunks are held back, so the form is still
 * the server's HTML when it is filled, and React attaches only afterwards. What was typed or ticked
 * is then in the DOM but in no state, and must survive React's first re-render and reach the submit.
 */
test.describe('/repos/new filled before React attaches its handler', () => {
  test('values filled before React attaches survive its first re-render and a refused submit', async ({
    page,
    users,
  }) => {
    await users.register(page.request, { prefix: 'repo-prehydrate-kept' });
    const typed = `prehydrate-${Date.now().toString(36)}`;
    let release = () => {};
    try {
      release = await holdScripts(page);
      await page.goto('/repos/new', { waitUntil: 'domcontentloaded' });
      expect(await reactAttached(page), 'the scripts were not held back').toBe(false);
      await page.getByLabel('Display name').fill(typed);
      await page.getByLabel('Branch (optional)').fill('feature/x');
      await page.getByLabel('Work on a writable copy').check();
      release();
      await waitForReact(page);
      await page.getByRole('button', { name: 'Create repository' }).click();

      await expect(
        page.getByText(/Pick a local directory containing a \.git folder/),
      ).toBeVisible();
      await expect.soft(page.getByLabel('Display name')).toHaveValue(typed);
      await expect.soft(page.getByLabel('Branch (optional)')).toHaveValue('feature/x');
      await expect.soft(page.getByLabel('Work on a writable copy')).toBeChecked();
    } finally {
      release();
    }
  });

  test('a name typed before React attaches is what the submit posts', async ({ page, users }) => {
    await users.register(page.request, { prefix: 'repo-prehydrate-posted' });
    const typed = `prehydrate-${Date.now().toString(36)}`;
    const posted: unknown[] = [];
    await page.route(`${API_ORIGIN}/repos`, async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      posted.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: { repository: { id: 'x' } } });
    });
    let release = () => {};
    try {
      release = await holdScripts(page);
      await page.goto('/repos/new', { waitUntil: 'domcontentloaded' });
      expect(await reactAttached(page), 'the scripts were not held back').toBe(false);
      await page.locator('#repo-name').fill(typed);
      await page.locator('#repo-branch').fill('feature/x');
      release();
      await waitForReact(page);
      await page.locator('#repo-source').selectOption('blank');
      // A Source switch empties the branch, as it always has.
      await expect(page.locator('#repo-branch')).toHaveValue('');
      await page.locator('#repo-branch').fill('feature/y');
      await page.getByRole('button', { name: 'Create repository' }).click();

      await expect
        .poll(() => posted)
        .toEqual([{ source: 'blank', name: typed, branch: 'feature/y' }]);
      await page.waitForURL(/\/repos$/, { timeout: 10_000 });
    } finally {
      release();
    }
  });
});
