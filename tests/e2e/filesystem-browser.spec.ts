import { expect, test, type APIRequestContext } from '@playwright/test';
import { cleanupUser, getSql } from './helpers/db.js';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3001';
const PASSWORD = 'e2e-password-12345';

function uniqueEmail(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}@haive-e2e.test`;
}

async function registerAndGetUserId(request: APIRequestContext, email: string): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password: PASSWORD },
  });
  expect(res.status(), `register failed: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  hasGit: boolean;
  hidden: boolean;
}

interface FsListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

async function fetchListing(request: APIRequestContext, path?: string): Promise<FsListing> {
  const url = path
    ? `${API_BASE}/filesystem?path=${encodeURIComponent(path)}`
    : `${API_BASE}/filesystem`;
  const res = await request.get(url);
  expect(res.status()).toBe(200);
  return (await res.json()) as FsListing;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('filesystem browser UI', () => {
  test('lists root entries and shows path', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('fs-list');
      userId = await registerAndGetUserId(page.request, email);

      const listing = await fetchListing(page.request);
      const firstDir = listing.entries.find((e) => e.isDirectory && !e.hidden);
      expect(firstDir, 'expected at least one visible dir under root').toBeDefined();

      await page.goto('/repos/new');
      await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();
      await expect(page.getByText(listing.path).first()).toBeVisible();
      await expect(
        page
          .getByRole('button', {
            name: new RegExp(`^dir\\s+${escapeRegex(firstDir!.name)}(\\s|$)`),
          })
          .first(),
      ).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('navigate into a subdirectory then back via Parent directory', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('fs-nav');
      userId = await registerAndGetUserId(page.request, email);

      const rootListing = await fetchListing(page.request);
      const targetDir = rootListing.entries.find((e) => e.isDirectory && !e.hidden);
      expect(targetDir).toBeDefined();

      await page.goto('/repos/new');
      await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();
      await expect(page.getByText(rootListing.path).first()).toBeVisible();

      await expect(page.getByRole('button', { name: 'Parent directory' })).toHaveCount(0);

      await page
        .getByRole('button', {
          name: new RegExp(`^dir\\s+${escapeRegex(targetDir!.name)}(\\s|$)`),
        })
        .first()
        .click();

      await expect(page.getByText(targetDir!.path)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Parent directory' })).toBeVisible();

      await page.getByRole('button', { name: 'Parent directory' }).click();
      await expect(page.getByRole('button', { name: 'Parent directory' })).toHaveCount(0);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('pick git directory shows selection caption', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('fs-pick');
      userId = await registerAndGetUserId(page.request, email);

      const listing = await fetchListing(page.request);
      const gitDir = listing.entries.find((e) => e.isDirectory && e.hasGit);
      test.skip(!gitDir, 'no git directory found under filesystem root, skipping pick test');

      await page.goto('/repos/new');
      await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();

      const pickButton = page.getByRole('button', { name: 'Pick' }).first();
      await expect(pickButton).toBeVisible();
      await pickButton.click();

      await expect(page.getByText(/Selected:/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Selected' }).first()).toBeVisible();
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });

  test('show hidden toggle reveals additional entries', async ({ page }) => {
    const sql = getSql();
    let userId = '';
    try {
      const email = uniqueEmail('fs-hidden');
      userId = await registerAndGetUserId(page.request, email);

      const listing = await fetchListing(page.request);
      const visibleDirs = listing.entries.filter((e) => e.isDirectory && !e.hidden).length;
      const allDirs = listing.entries.filter((e) => e.isDirectory).length;
      test.skip(allDirs === visibleDirs, 'no hidden directories under root, skipping toggle test');

      await page.goto('/repos/new');
      await expect(page.getByRole('heading', { name: 'Add a repository' })).toBeVisible();
      await expect(page.getByText(listing.path).first()).toBeVisible();

      const dirButtons = page.getByRole('button', { name: /^dir\s+/ });
      const baseCount = await dirButtons.count();

      await page.getByLabel('Show hidden').check();

      await expect
        .poll(async () => dirButtons.count(), { timeout: 5_000 })
        .toBeGreaterThan(baseCount);
    } finally {
      if (userId) await cleanupUser(sql, userId);
      await sql.end({ timeout: 5 });
    }
  });
});
