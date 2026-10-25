/** Run against bundle-recovery-smoke.ts --serve and a real Next server using the same API origin.
 * All mutations below are fixture writes to the explicitly supplied isolated database. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import postgres from 'postgres';

async function main(): Promise<void> {
  const databaseUrl = process.env.HAIVE_TEST_DATABASE_URL;
  const metadataPath = process.env.HAIVE_TEST_BROWSER_METADATA;
  const evidence = process.env.HAIVE_TEST_BROWSER_EVIDENCE;
  const webOrigin = process.env.HAIVE_TEST_WEB_ORIGIN;
  const apiOrigin = process.env.HAIVE_TEST_API_ORIGIN;
  assert(
    databaseUrl && metadataPath && evidence && webOrigin && apiOrigin,
    'explicit isolated browser fixture configuration is required',
  );
  assert(new URL(databaseUrl).pathname !== '/haive', 'the development database is forbidden');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    token: string;
    taskId: string;
    bundleId: string;
    zipId: string;
  };
  const sql = postgres(databaseUrl);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.HAIVE_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.HAIVE_TEST_BROWSER_EXECUTABLE }
      : {}),
  });
  console.info(`Browser: ${browser.version()}; real web ${webOrigin}, API ${apiOrigin}`);
  try {
    for (const width of [375, 768, 1280]) {
      await sql`UPDATE custom_bundles SET status='syncing', last_sync_error=NULL WHERE id IN (${metadata.bundleId}, ${metadata.zipId})`;
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addCookies([
        { name: 'haive_access', value: metadata.token, url: webOrigin, sameSite: 'Lax' },
      ]);
      const page = await context.newPage();
      try {
        await page.goto(`${webOrigin}/tasks/${metadata.taskId}`);
        await page.getByRole('button', { name: /Git fixture/ }).waitFor();
        const diagnosis =
          'Git pull failed for https://fixture-user:fixture-password@example.invalid/project. Check credentials and select Resync.';
        const zipDiagnosis = 'Archive import failed. Replace ZIP to retry.';
        // These writes happen after the live composer mounted; its poll must receive and render them.
        const response = page.waitForResponse(
          (r) => r.url().startsWith(`${apiOrigin}/bundles?`) && r.status() === 200,
        );
        await sql`UPDATE custom_bundles SET status='failed', last_sync_error=${diagnosis} WHERE id=${metadata.bundleId}`;
        await sql`UPDATE custom_bundles SET status='failed', last_sync_error=${zipDiagnosis} WHERE id=${metadata.zipId}`;
        const payload = await (await response).text();
        assert(
          !payload.includes('fixture-password') && !payload.includes('fixture-user'),
          'actual asynchronous API serialization must redact credentials',
        );
        const alert = page
          .getByRole('alert')
          .filter({ hasText: 'Check credentials and select Resync.' });
        await alert.waitFor({ timeout: 15_000 });
        assert.equal(await alert.locator('.haive-md').count(), 1, 'diagnosis uses MarkdownView');
        await page.getByRole('alert').filter({ hasText: zipDiagnosis }).waitFor();
        assert(!(await page.locator('body').innerText()).includes('fixture-password'));
        assert(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          'no horizontal overflow',
        );
        const resync = page.getByRole('button', { name: 'Resync', exact: true });
        assert(await resync.isEnabled());
        const bounds = await resync.boundingBox();
        assert(
          bounds && bounds.x >= 0 && bounds.x + bounds.width <= width,
          'Resync remains visible',
        );
        await page.screenshot({
          path: path.join(evidence, `browser-${width}.png`),
          fullPage: true,
        });
        const sent = page.waitForResponse(
          (r) =>
            r.url() === `${apiOrigin}/bundles/${metadata.bundleId}/sync` &&
            r.request().method() === 'POST',
        );
        await resync.click();
        assert.equal(
          (await sent).status(),
          200,
          'visible Resync reaches the authenticated real API',
        );
        await alert.waitFor({ state: 'hidden' });
        // A stale diagnostic on a successful row stays hidden: status is the source of truth.
        await sql`UPDATE custom_bundles SET status='active' WHERE id=${metadata.bundleId}`;
        await page.waitForResponse(
          (r) => r.url().startsWith(`${apiOrigin}/bundles?`) && r.status() === 200,
        );
        assert.equal(
          await page.getByRole('alert').filter({ hasText: 'Check credentials' }).count(),
          0,
        );
        console.info(
          `PASS ${width}px: async failure, credential redaction, MarkdownView, readable controls, real Resync and status-gated stale copy`,
        );
      } catch (err) {
        await page.screenshot({
          path: path.join(evidence, `browser-failure-${width}.png`),
          fullPage: true,
        });
        throw err;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await sql.end({ timeout: 5 });
    console.info('CLEANED browser contexts, browser process and fixture database connection');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
