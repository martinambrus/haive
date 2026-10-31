import { expect, test, type Locator, type Page } from '@playwright/test';
import { cleanupUser, getSql } from '../helpers/db.js';
import { API_BASE, PASSWORD, registerUser, seedInvite, uniqueEmail } from '../helpers/auth.js';
import { holdScripts, reactAttached, waitForReact } from '../helpers/hydration.js';

/**
 * A submit before React attaches AuthForm's handler is the browser's own. Without `method="post"`
 * on the form that is a GET, which puts the email, password and setup token in the URL, the
 * history and every access log. Turning JavaScript off stands in for that window: the page is the
 * server-rendered HTML and nothing ever attaches. Each auth page is submitted twice, by its button
 * and by Enter in the Password field, and the credentials must not appear in any navigation.
 */
const TARGETS = [
  { path: '/login', button: 'Sign in', heading: 'Sign in to Haive', invited: false },
  {
    path: '/register',
    button: 'Create account',
    heading: 'Create your Haive account',
    invited: true,
  },
  {
    path: '/setup',
    button: 'Create administrator account',
    heading: 'Set up Haive',
    invited: false,
  },
];

test.describe('auth forms submitted before React attaches its handler', () => {
  test.use({ javaScriptEnabled: false });

  for (const target of TARGETS) {
    for (const via of ['the button', 'Enter in the Password field'] as const) {
      test(`${target.path}: submitting with ${via} keeps the credentials out of the URL`, async ({
        page,
      }) => {
        const sql = getSql();
        let inviteId = '';
        try {
          let path: string = target.path;
          if (target.invited) {
            const invite = await seedInvite(sql);
            inviteId = invite.id;
            path = `${target.path}?invite=${invite.token}`;
          }
          const email = uniqueEmail('prehydrate');
          const navigations: Array<{ method: string; url: string }> = [];
          page.on('request', (request) => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
              navigations.push({ method: request.method(), url: request.url() });
            }
          });

          await page.goto(path);
          await expect(page.getByRole('heading', { name: target.heading })).toBeVisible();
          const started = page.url();

          await page.getByLabel('Email').fill(email);
          await page.getByLabel('Password').fill(PASSWORD);
          if (via === 'the button') {
            await page.getByRole('button', { name: target.button }).click();
          } else {
            await page.getByLabel('Password').press('Enter');
          }
          await page.waitForLoadState('load');

          const secrets = [email, encodeURIComponent(email), PASSWORD, 'password='];
          const leaked = [...navigations.map((navigation) => navigation.url), page.url()].filter(
            (url) => secrets.some((secret) => url.includes(secret)),
          );
          expect(leaked).toEqual([]);
          expect(navigations.at(-1)?.method).toBe('POST');
          expect(page.url()).toBe(started);
          await expect(page.getByRole('heading', { name: target.heading })).toBeVisible();
        } finally {
          if (inviteId) await sql`delete from user_invites where id = ${inviteId}`;
          await sql.end({ timeout: 5 });
        }
      });
    }
  }
});

const API_ORIGIN = new URL(API_BASE).origin;

function capturePosts(page: Page, path: string): unknown[] {
  const bodies: unknown[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.origin === API_ORIGIN && url.pathname === path) {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

const fillAs = (how: 'typed' | 'autofilled', field: Locator, value: string) =>
  how === 'typed'
    ? field.fill(value)
    : field.evaluate((el, v) => {
        (el as HTMLInputElement).value = v;
      }, value);

/**
 * The same window with JavaScript on. The page's script chunks are held back, so the form is still
 * the server's HTML when it is filled, by typing or by autofill (which assigns the value and fires
 * no event), and React attaches only afterwards. What the submit posts must then be what the fields
 * hold, and a submit the api refuses must leave them holding it.
 */
test.describe('auth forms filled before React attaches its handler', () => {
  for (const how of ['typed', 'autofilled'] as const) {
    test(`/login: a value ${how} before React attaches is what the submit posts`, async ({
      page,
      playwright,
    }) => {
      const sql = getSql();
      const ctx = await playwright.request.newContext();
      let release = () => {};
      let userId = '';
      try {
        const user = await registerUser(sql, ctx, { prefix: 'prehydrate-login' });
        userId = user.userId;
        release = await holdScripts(page);
        const posted = capturePosts(page, '/auth/login');

        await page.goto('/login', { waitUntil: 'domcontentloaded' });
        expect(await reactAttached(page), 'the scripts were not held back').toBe(false);
        await fillAs(how, page.getByLabel('Email'), user.email);
        await fillAs(how, page.getByLabel('Password'), PASSWORD);
        release();
        await waitForReact(page);
        await page.getByRole('button', { name: 'Sign in' }).click();

        await expect.poll(() => posted).toEqual([{ email: user.email, password: PASSWORD }]);
        await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });
      } finally {
        release();
        if (userId) await cleanupUser(sql, userId);
        await sql.end({ timeout: 5 });
        await ctx.dispose();
      }
    });
  }

  test('/register: values typed before React attaches are posted with the invite token', async ({
    page,
  }) => {
    const sql = getSql();
    let release = () => {};
    let inviteId = '';
    let userId = '';
    try {
      const invite = await seedInvite(sql);
      inviteId = invite.id;
      const email = uniqueEmail('prehydrate-reg');
      release = await holdScripts(page);
      const posted = capturePosts(page, '/auth/register');

      await page.goto(`/register?invite=${invite.token}`, { waitUntil: 'domcontentloaded' });
      expect(await reactAttached(page), 'the scripts were not held back').toBe(false);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(PASSWORD);
      release();
      await waitForReact(page);
      await page.getByRole('button', { name: 'Create account' }).click();

      await expect
        .poll(() => posted)
        .toEqual([{ email, password: PASSWORD, inviteToken: invite.token }]);
      await page.waitForURL(/\/dashboard$/, { timeout: 10_000 });

      const meRes = await page.request.get(`${API_BASE}/auth/me`);
      expect(meRes.status()).toBe(200);
      userId = ((await meRes.json()) as { user: { id: string } }).user.id;
    } finally {
      release();
      if (userId) await cleanupUser(sql, userId);
      if (inviteId) await sql`delete from user_invites where id = ${inviteId}`;
      await sql.end({ timeout: 5 });
    }
  });

  test('/login: a submit the api refuses leaves the fields as they were filled', async ({
    page,
    playwright,
  }) => {
    const sql = getSql();
    const ctx = await playwright.request.newContext();
    let release = () => {};
    let userId = '';
    try {
      const user = await registerUser(sql, ctx, { prefix: 'prehydrate-refused' });
      userId = user.userId;
      const wrong = `${PASSWORD}-wrong`;
      release = await holdScripts(page);
      const posted = capturePosts(page, '/auth/login');

      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      expect(await reactAttached(page), 'the scripts were not held back').toBe(false);
      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill(wrong);
      release();
      await waitForReact(page);
      await page.getByLabel('Password').press('Enter');

      await expect(page.getByRole('main').getByRole('alert')).toContainText(/invalid credentials/i);
      expect(posted).toEqual([{ email: user.email, password: wrong }]);
      await expect(page.getByLabel('Email')).toHaveValue(user.email);
      await expect(page.getByLabel('Password')).toHaveValue(wrong);
    } finally {
      release();
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
      await ctx.dispose();
    }
  });
});
