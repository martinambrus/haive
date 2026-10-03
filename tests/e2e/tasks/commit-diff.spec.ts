import { randomUUID } from 'node:crypto';
import { expect, test } from '../helpers/fixtures.js';

test('text highlights and the change map work in inline, split and fullscreen views', async ({
  page,
  sql,
  users,
}) => {
  const { userId } = await users.register(page.request, { prefix: 'commit-diff' });
  const taskId = randomUUID();
  const stepId = randomUUID();
  const artifactPath = '.haive/commit-diff.json';
  // A completed record cannot dispatch work; only the artifact response is mocked.
  await sql`
    insert into tasks (id, user_id, type, title, status, current_step_id, current_step_index, completed_at)
    values (${taskId}, ${userId}, 'workflow', 'Diff viewer fixture', 'completed', '10-gate-3-commit', 0, now())
  `;
  await sql`
    insert into task_steps (id, task_id, step_id, step_index, title, status, detect_output, ended_at)
    values (${stepId}, ${taskId}, '10-gate-3-commit', 0, 'Commit changes', 'done',
      ${sql.json({ diffArtifactPath: artifactPath })}, now())
  `;
  const context = Array.from({ length: 500 }, (_, i) => `// Unchanged context ${i + 1}`);
  const oldLines = [...context];
  const newLines = [...context];
  oldLines[300] = "// $settings['config_sync_directory'] = '/some/other/path';";
  newLines[300] = "$settings['config_sync_directory'] = '../config/sync';";
  oldLines.splice(50, 0, '// Removed comment');
  newLines.push('// Added last line');
  const file = {
    path: 'web/sites/default/settings.php',
    status: 'modified',
    binary: false,
    truncated: false,
    oldContent: `${oldLines.join('\n')}\n`,
    newContent: `${newLines.join('\n')}\n`,
  };
  await page.route(`**/tasks/${taskId}/files/raw?*`, (route) =>
    route.fulfill({
      json: {
        headSha: null,
        fileCount: 2,
        truncated: false,
        files: [file, { ...file, path: 'short.txt', oldContent: 'old\n', newContent: 'new\n' }],
      },
    }),
  );
  await page.goto(`/tasks/${taskId}`);
  const viewer = page.locator(`[data-step-id="${stepId}"]`);
  const map = viewer.getByRole('navigation', { name: 'File changes' });
  await expect(map).toBeVisible();
  await expect(map.getByRole('button')).toHaveCount(4);
  const removal = map.getByRole('button', { name: 'Jump to removed line 51 (old file)' });
  await removal.focus();
  await page.keyboard.press('Enter');
  await expect(
    viewer.locator('[data-diff-pane="inline"]').getByText('- // Removed comment', { exact: true }),
  ).toBeInViewport();
  await viewer.locator('[data-diff-pane="inline"]').evaluate((el) => {
    el.scrollTop = 0;
  });

  for (const view of ['Inline', 'Side-by-side']) {
    await viewer.getByRole('button', { name: view, exact: true }).click();
    const pane = viewer.locator(`[data-diff-pane="${view === 'Inline' ? 'inline' : 'right'}"]`);
    const changed = pane.locator('[data-diff-highlight="add"]', { hasText: 'sync' });
    // The marker stays visible even when the change is far below the scroll viewport.
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    const marker = map.getByRole('button', { name: 'Jump to added line 301 (new file)' });
    await expect(marker).toBeVisible();
    await marker.click();
    // The long setting can extend beyond the half-width split pane.
    await pane.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await expect(changed).toBeInViewport();
    expect(await pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(viewer.locator('[data-diff-highlight="remove"]', { hasText: '//' })).toHaveCount(
      1,
    );
    expect(await changed.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)',
    );
    if (view === 'Side-by-side') {
      const left = viewer.locator('[data-diff-pane="left"]');
      const screenshot = test.info().outputPath('setting-diff.png');
      await viewer.screenshot({ path: screenshot });
      await test.info().attach('setting diff', {
        path: screenshot,
        contentType: 'image/png',
      });
      await expect
        .poll(async () =>
          Math.abs(
            (await left.evaluate((el) => el.scrollTop)) -
              (await pane.evaluate((el) => el.scrollTop)),
          ),
        )
        .toBeLessThan(1);
      // Manual scrolling still synchronizes the two sides.
      await left.evaluate((el) => {
        el.scrollTop = 500;
      });
      await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBe(500);
    }
  }

  await viewer.getByRole('button', { name: 'Maximize', exact: true }).click();
  await map.getByRole('button', { name: 'Jump to added line 501 (new file)' }).click();
  await expect(
    viewer.locator('[data-diff-pane="right"]').getByText('// Added last line', { exact: true }),
  ).toBeInViewport();
  await page.keyboard.press('Escape');
  await viewer.getByRole('button', { name: 'short.txt', exact: false }).click();
  await expect(map.getByRole('button')).toHaveCount(2);
  expect(await viewer.locator('[data-diff-pane="right"]').evaluate((el) => el.scrollTop)).toBe(0);

  // Both layouts keep the overview inside the pane on narrow screens too.
  await page.setViewportSize({ width: 375, height: 812 });
  await viewer.getByRole('button', { name: file.path, exact: false }).click();
  for (const view of ['Inline', 'Side-by-side']) {
    await viewer.getByRole('button', { name: view, exact: true }).click();
    await expect(map).toBeVisible();
    expect(
      await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
});
