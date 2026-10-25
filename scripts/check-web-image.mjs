import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

// Run the production artifact's own CMD, with no bind mounts or API/DB/provider services.
// Resolve to an image ID so the checked artifact is exactly the locally built image.
const [image, port = '3999'] = process.argv.slice(2);
assert.ok(image, 'usage: node scripts/check-web-image.mjs IMAGE [PORT]');
assert.match(port, /^\d+$/);
assert.ok(Number(port) > 0 && Number(port) <= 65535, 'invalid port');
const timeout = Number(process.env.WEB_IMAGE_TIMEOUT_MS ?? 60_000);
assert.ok(timeout >= 1000 && timeout <= 120_000, 'timeout must be 1000..120000ms');
const name = `haive-web-check-${randomUUID()}`;
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 }).trim();
const id = docker('image', 'inspect', '--format', '{{.Id}}', image);
const base = `http://127.0.0.1:${port}`;
let created = false;
try {
  docker(
    'create',
    '--pull',
    'never',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:3000`,
    '-e',
    'API_URL_INTERNAL=http://127.0.0.1:9',
    '-e',
    'HAIVE_API_PORT=46113',
    id,
  );
  created = true;
  docker('start', name);
  const deadline = Date.now() + timeout;
  let login;
  let lastError;
  while (Date.now() < deadline) {
    try {
      login = await fetch(`${base}/login`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2000),
      });
      if (login.status === 200) break;
      lastError = `HTTP ${login.status}`;
      await login.body?.cancel();
    } catch (error) {
      lastError = error.message;
    }
    if (docker('inspect', '--format', '{{.State.Running}}', name) !== 'true') break;
    await setTimeout(250);
  }
  assert.equal(login?.status, 200, `/login failed: ${lastError}`);
  const csp = login.headers.get('content-security-policy');
  assert.equal(
    csp,
    "img-src 'self' data: blob: http://127.0.0.1:46113 https://127.0.0.1:46113; media-src 'self' blob: http://127.0.0.1:46113 https://127.0.0.1:46113; font-src 'self' data:",
  );
  assert.equal(login.headers.get('set-cookie'), null, 'anonymous login must not change cookies');
  assert.match(await login.text(), /Sign in/, 'login must render the actual auth layout');
  const dashboard = await fetch(`${base}/dashboard`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(dashboard.status, 307, 'anonymous /dashboard must redirect');
  assert.equal(new URL(dashboard.headers.get('location') ?? '', base).href, `${base}/login`);
  assert.equal(dashboard.headers.get('set-cookie'), null);
  await dashboard.body?.cancel();
  console.log(
    `ok: ${image} (${id}) boots its production CMD; /login 200 + CSP, /dashboard 307 -> /login`,
  );
} catch (error) {
  if (created) console.error(docker('logs', name));
  throw error;
} finally {
  if (created) docker('rm', '-f', name);
}
