import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    runtimeFixture: {
      editor(markdown: string): { html: string; json: unknown; markdown: string };
      mermaid(source: string): Promise<string | null>;
    };
    runtimeExecuted?: boolean;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/e2e/harness/web-runtime/index.html');
  await page.waitForFunction(() => !!window.runtimeFixture);
});

test('the actual markdown-it string path parses formatting, task lists and preserved image labels', async ({
  page,
  request,
}) => {
  const before = await (await request.get('http://127.0.0.1:46113/count')).text();
  const parsed = await page.evaluate(() =>
    window.runtimeFixture.editor(
      '**bold** and [safe](https://example.test/docs)\n\n- [ ] open\n- [x] done\n\n![diagram](http://127.0.0.1:46113/editor-image.svg)\n\n<em>raw HTML</em>',
    ),
  );
  await expect(page.locator('#output strong')).toHaveText('bold');
  await expect(page.locator('#output a')).toHaveAttribute('href', 'https://example.test/docs');
  await expect(page.locator('#output li[data-type="taskItem"]')).toHaveCount(2);
  await expect(page.locator('#output em')).toHaveText('raw HTML');
  await expect(page.locator('#output [data-md-image]')).toHaveText('image: diagram');
  await expect(page.locator('#output img')).toHaveCount(0);
  expect(parsed.markdown).toContain('![diagram](http://127.0.0.1:46113/editor-image.svg)');
  expect(parsed.markdown).toContain('- [x] done');
  expect(await (await request.get('http://127.0.0.1:46113/count')).text()).toBe(before);
});

test('HTML and unsafe link input cannot create executable editor DOM or fetch images', async ({
  page,
  request,
}) => {
  const before = await (await request.get('http://127.0.0.1:46113/count')).text();
  await page.evaluate(() =>
    window.runtimeFixture.editor(
      '<p onclick="window.runtimeExecuted=true">kept <a href="javascript:window.runtimeExecuted=true">unsafe</a></p>\n\n<script>window.runtimeExecuted=true</script>\n\n<img src="http://127.0.0.1:46113/raw-image.svg" onerror="window.runtimeExecuted=true" alt="raw">\n\n[bad](javascript:alert(1))',
    ),
  );
  await expect(page.locator('#output')).toContainText('kept');
  await expect(
    page.locator('#output script, #output img, #output [onclick], #output [onerror]'),
  ).toHaveCount(0);
  await expect(page.locator('#output a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.runtimeExecuted)).toBeUndefined();
  expect(await (await request.get('http://127.0.0.1:46113/count')).text()).toBe(before);
});

test('real mermaid rendering runs DOMPurify and strips resource and link attributes from SVG', async ({
  page,
  request,
}) => {
  const before = await (await request.get('http://127.0.0.1:46113/count')).text();
  const svg = await page.evaluate(() =>
    window.runtimeFixture.mermaid(
      'flowchart LR\n A["<img src=\'http://127.0.0.1:46113/mermaid-image.svg\' onerror=\'window.runtimeExecuted=true\'>Hello"] --> B[Done]\n click B "https://example.test/remote" "tooltip"',
    ),
  );
  expect(svg).not.toBeNull();
  expect(svg).not.toContain('mermaid-image.svg');
  expect(svg).not.toContain('window.runtimeExecuted');
  await expect(page.locator('#output svg')).toHaveCount(1);
  await expect(page.locator('#output svg')).toContainText('Hello');
  await expect(page.locator('#output svg')).toContainText('Done');
  expect(
    await page
      .locator(
        '#output img, #output image, #output foreignObject, #output script, #output [href], #output [src], #output [onerror]',
      )
      .evaluateAll((elements) => elements.map((element) => element.outerHTML)),
  ).toEqual([]);
  expect(await page.evaluate(() => window.runtimeExecuted)).toBeUndefined();
  expect(await (await request.get('http://127.0.0.1:46113/count')).text()).toBe(before);
});

test('the browser enforces the actual CSP while allowing an API image', async ({
  page,
  request,
}) => {
  const before = Number(await (await request.get('http://127.0.0.1:46113/count')).text());
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.blockedURI),
    );
    const load = (src: string) =>
      new Promise<string>((resolve) => {
        const img = new Image();
        img.onload = () => resolve('loaded');
        img.onerror = () => resolve('blocked');
        img.src = src;
        document.body.append(img);
      });
    const allowed = await load('http://127.0.0.1:46113/allowed.svg');
    const denied = await load('http://localhost:46113/denied.svg');
    return { allowed, denied, violations };
  });
  expect(result.allowed).toBe('loaded');
  expect(result.denied).toBe('blocked');
  expect(result.violations).toContain('http://localhost:46113/denied.svg');
  expect(Number(await (await request.get('http://127.0.0.1:46113/count')).text())).toBe(before + 1);
});
