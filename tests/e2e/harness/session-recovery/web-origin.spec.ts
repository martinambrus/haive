import { connect } from 'node:net';
import { expect, test } from '@playwright/test';

const API = 'http://127.0.0.1:46101';
const WEB = 'http://localhost:46100';
const PREFIX = '/api/haive';
const ID = '11111111-2222-3333-4444-555555555555';

test.skip(!process.env.SESSION_RECOVERY_CROSS_HOST, 'Opt-in different-hostname transport control');

function handshake(path: string, origin: string, cookie = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = connect(46100, '127.0.0.1', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          'Host: localhost:46100',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          `Origin: ${origin}`,
          `Cookie: ${cookie}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.setTimeout(10_000, () =>
      socket.destroy(new Error(`Upgrade timed out: ${path}: ${data}`)),
    );
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) {
        resolve(data.split('\r\n')[0] ?? '');
        socket.destroy();
      }
    });
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

test('web-origin login establishes the SSR and proxied API session across hostnames', async ({
  page,
  context,
}) => {
  const seed = await context.request.post(`${API}/__fixture/session`, { data: {} });
  expect(seed.status()).toBe(200);
  const user = (await seed.json()) as { id: string; email: string };
  await context.clearCookies();
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(API)) apiRequests.push(request.url());
  });
  try {
    await page.goto(`${WEB}/login?session=expired`);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill('synthetic-original-password-1');
    const login = page.waitForResponse((response) => response.url().endsWith('/auth/login'));
    await page.getByRole('button', { name: /sign in/i }).click();
    const response = await login;
    expect(response.status()).toBe(200);
    expect(new URL(response.url()).origin).toBe(WEB);
    const setCookies = await response.headerValues('set-cookie');
    expect(setCookies).toHaveLength(2);
    for (const line of setCookies) {
      expect(line).toContain('HttpOnly');
      expect(line).toContain('SameSite=Lax');
      expect(line).not.toMatch(/Domain=/i);
    }
    await page.goto(`${WEB}/settings/account`);
    await expect(page.locator('.haive-shell')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Authenticated fixture', exact: true }),
    ).toBeVisible();
    expect((await context.request.get(`${WEB}${PREFIX}/auth/me`)).status()).toBe(200);
    const oldRefresh = (await context.cookies()).find(
      (cookie) => cookie.name === 'haive_refresh',
    )!.value;
    await context.clearCookies({ name: 'haive_access' });
    await page.goto(`${WEB}/settings/account`);
    await expect(page.locator('.haive-shell')).toBeVisible();
    expect(
      (await context.cookies()).find((cookie) => cookie.name === 'haive_refresh')!.value,
    ).not.toBe(oldRefresh);
    const redeemed = await context.request.post(`${WEB}${PREFIX}/auth/refresh`, {
      headers: { Cookie: `haive_refresh=${oldRefresh}`, Origin: WEB },
    });
    expect(redeemed.status()).toBe(401);
    expect(redeemed.headers()['set-cookie']).toBeUndefined();
    const cookies = await context.cookies();
    expect(
      cookies
        .filter((cookie) => cookie.name.startsWith('haive_'))
        .every((cookie) => cookie.domain === 'localhost'),
    ).toBe(true);
    const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    for (const path of [`${PREFIX}/terminal/${ID}`, `/ide/${ID}/`]) {
      expect(await handshake(path, WEB, cookie)).toBe('HTTP/1.1 404 Not Found');
      expect(await handshake(path, WEB)).toBe('HTTP/1.1 401 Unauthorized');
      expect(await handshake(path, 'http://localhost:5173', cookie)).toBe('HTTP/1.1 403 Forbidden');
    }
    expect(
      (
        await context.request.post(`${WEB}${PREFIX}/auth/logout`, {
          headers: { Origin: 'http://localhost:5173' },
        })
      ).status(),
    ).toBe(403);
    expect((await context.request.get(`${WEB}${PREFIX}/auth/me`)).status()).toBe(200);
    await page.reload();
    await expect(page.locator('.haive-shell')).toBeVisible();
    expect(apiRequests).toEqual([]);
    const upload = Buffer.alloc(12 * 1024 * 1024, 0x61);
    const echo = await context.request.post(`${WEB}${PREFIX}/__fixture/echo`, {
      data: upload,
      headers: { Origin: WEB },
    });
    expect(echo.status()).toBe(200);
    expect(await echo.body()).toEqual(upload);
    const asset = await context.request.get(`${WEB}/ide/${ID}/redirect`);
    expect(asset.url()).toBe(`${WEB}/ide/${ID}/asset.js`);
    expect(await asset.text()).toBe('editor asset');
    const events = await context.request.get(`${WEB}${PREFIX}/__fixture/events`);
    expect(events.status()).toBe(200);
    expect(await events.text()).toContain('data: after-default-proxy-timeout');
  } finally {
    await context.request.delete(`${API}/__fixture/session/${user.id}`);
  }
});

test('raw SVG headers survive the proxy, block top-level script and retain image rendering', async ({
  page,
  context,
}) => {
  const seed = await context.request.post(`${API}/__fixture/session`, { data: {} });
  const user = (await seed.json()) as { id: string; email: string };
  try {
    const workspace = await context.request.post(`${API}/__fixture/workspace/${user.id}`);
    expect(workspace.status()).toBe(200);
    const { taskId, svgPath } = (await workspace.json()) as { taskId: string; svgPath: string };
    const path = `/tasks/${taskId}/files/raw?path=${encodeURIComponent(svgPath)}`;
    const direct = await context.request.get(`${API}${path}`);
    expect(direct.status()).toBe(200);
    expect(direct.headers()['x-content-type-options']).toBe('nosniff');
    expect(direct.headers()['content-security-policy']).toBe('sandbox');
    await context.clearCookies();
    const login = await context.request.post(`${WEB}${PREFIX}/auth/login`, {
      data: { email: user.email, password: 'synthetic-original-password-1' },
      headers: { Origin: WEB },
    });
    expect(login.status()).toBe(200);
    const raw = await context.request.get(`${WEB}${PREFIX}${path}`);
    expect(raw.status()).toBe(200);
    expect(raw.headers()['x-content-type-options']).toBe('nosniff');
    expect(raw.headers()['content-security-policy']).toBe('sandbox');
    await page.goto(`${WEB}/login?session=expired`);
    await page.evaluate(() => localStorage.removeItem('raw-script-ran'));
    await page.setContent(`<img src="${WEB}${PREFIX}${path}">`);
    await expect
      .poll(() =>
        page
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 16),
      )
      .toBe(true);
    await page.goto(`${WEB}${PREFIX}${path}`);
    await page.goto(`${WEB}/login?session=expired`);
    expect(await page.evaluate(() => localStorage.getItem('raw-script-ran'))).toBeNull();
  } finally {
    await context.request.delete(`${API}/__fixture/session/${user.id}`);
  }
});

test('terminal WebSocket completes a 101 upgrade and relays input and output through web', async ({
  page,
  context,
}) => {
  const seed = await context.request.post(`${API}/__fixture/session`, { data: {} });
  const user = (await seed.json()) as { id: string; email: string };
  try {
    const workspace = await context.request.post(`${API}/__fixture/workspace/${user.id}`);
    expect(workspace.status()).toBe(200);
    const { containerId } = (await workspace.json()) as { containerId: string };
    await context.clearCookies();
    expect(
      (
        await context.request.post(`${WEB}${PREFIX}/auth/login`, {
          data: { email: user.email, password: 'synthetic-original-password-1' },
          headers: { Origin: WEB },
        })
      ).status(),
    ).toBe(200);
    await page.goto(`${WEB}/settings/account`);
    const result = await page.evaluate(
      (url) =>
        new Promise<{ opened: boolean; output: string }>((resolve, reject) => {
          const ws = new WebSocket(url);
          let opened = false;
          const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Terminal relay timed out'));
          }, 10_000);
          ws.onopen = () => {
            opened = true;
          };
          ws.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('Terminal upgrade failed'));
          };
          ws.onmessage = (event) => {
            const frame = JSON.parse(String(event.data)) as {
              type: string;
              data?: string;
              message?: string;
            };
            if (frame.type === 'connected')
              ws.send(JSON.stringify({ type: 'input', data: 'h2b-terminal-echo' }));
            if (frame.type === 'output') {
              clearTimeout(timeout);
              ws.close();
              resolve({ opened, output: frame.data ?? '' });
            }
            if (frame.type === 'error') {
              clearTimeout(timeout);
              ws.close();
              reject(new Error(frame.message));
            }
          };
        }),
      `ws://localhost:46100${PREFIX}/terminal/${containerId}`,
    );
    expect(result).toEqual({ opened: true, output: 'h2b-terminal-echo' });
  } finally {
    await context.request.delete(`${API}/__fixture/session/${user.id}`);
  }
});
