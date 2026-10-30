import { expect, test } from '@playwright/test';
import { getSql } from '../helpers/db.js';
import { PASSWORD, seedInvite, uniqueEmail } from '../helpers/auth.js';

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
