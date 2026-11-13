import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchWebPage, waitForWebLogin, WEB_IMAGE_LIMITS } from '../lib/web-image-probe.mjs';

const script = fileURLToPath(new URL('../check-web-image.mjs', import.meta.url));

function run(t, pending = false) {
  const dir = mkdtempSync(join(tmpdir(), 'web-image-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'docker.log');
  const preload = join(dir, 'preload.mjs');
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
childProcess.execFileSync = (command, args) => {
  if (command !== 'docker') throw new Error('unexpected command');
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
  if (args[0] === 'image') return 'sha256:fixture';
  if (args[0] === 'inspect') return 'true';
  return '';
};
syncBuiltinESMExports();
let attempts = 0;
globalThis.fetch = async (url, options) => {
  if (!(options.signal instanceof AbortSignal)) throw new Error('missing request signal');
  if (options.redirect !== 'manual') throw new Error('redirect was followed');
  if (${pending}) {
    // A pending fetch with no active socket. AbortSignal.timeout alone is unref'ed:
    // it cannot keep Node alive to report the failure or run container cleanup.
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
  }
  if (url.endsWith('/dashboard')) {
    return new Response(null, { status: 307, headers: { location: '/login' } });
  }
  if (++attempts === 1) return new Response('starting', { status: 503 });
  return new Response('Sign in', { headers: { 'content-security-policy':
    "img-src 'self' data: blob: http://127.0.0.1:46113 https://127.0.0.1:46113; media-src 'self' blob: http://127.0.0.1:46113 https://127.0.0.1:46113; font-src 'self' data:; frame-src 'self' http://127.0.0.1:46113 https://127.0.0.1:46113"
  } });
};
`,
  );
  const out = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, script, 'fixture-image'],
    {
      encoding: 'utf8',
      env: { WEB_IMAGE_TIMEOUT_MS: '1000' },
      timeout: 4000, // external process guard; no elapsed-time assertions
    },
  );
  return { out, calls: readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('the CLI waits for readiness and checks the production routing contract', (t) => {
  const { out, calls } = run(t);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /ok: fixture-image/);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['rm', '-f']);
});

test('a fetch with no active handles fails clearly and removes the container', (t) => {
  const { out, calls } = run(t, true);
  assert.equal(out.error, undefined);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stderr, /\/login.*not ready.*1000ms.*timed out/s);
  assert.doesNotMatch(out.stderr, /unsettled top-level await/);
  assert.ok(calls.some(([command]) => command === 'logs'));
  assert.deepEqual(calls.at(-1).slice(0, 2), ['rm', '-f']);
});

test('production probe budgets stay pinned', () => {
  assert.deepEqual(WEB_IMAGE_LIMITS, {
    readinessMs: 60_000,
    requestMs: 2000,
    dashboardMs: 5000,
    pollMs: 250,
  });
});

for (const phase of ['headers', 'body']) {
  test(`the request deadline aborts stalled ${phase}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal;
    const pending = new Promise(() => {});
    const request = fetchWebPage('http://fixture/dashboard', {
      timeoutMs: 4,
      fetchImpl: async (url, options) => {
        signal = options.signal;
        return phase === 'headers' ? pending : { text: () => pending };
      },
    });
    const rejected = assert.rejects(request, /dashboard timed out after 4ms/);
    // Let fetch resolve so the body case is pending inside text(), not at fetch().
    await Promise.resolve();
    t.mock.timers.tick(4);
    await rejected;
    assert.equal(signal.aborted, true);
  });
}

test('a completed response clears its deadline after reading the body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const page = await fetchWebPage('http://fixture/login', {
    timeoutMs: 4,
    fetchImpl: async (url, options) => {
      signal = options.signal;
      return new Response('Sign in');
    },
  });
  assert.equal(page.text, 'Sign in');
  t.mock.timers.tick(4);
  assert.equal(signal.aborted, false);
});

test('readiness retries connection failures and non-ready HTTP responses in order', async () => {
  let clock = 0;
  const events = [];
  const page = await waitForWebLogin('http://fixture', {
    timeoutMs: 10,
    pollMs: 2,
    now: () => clock,
    wait: async (ms) => {
      events.push(`wait ${ms}`);
      clock += ms;
    },
    isRunning: () => {
      events.push('running');
      return true;
    },
    fetchImpl: async () => {
      events.push('fetch');
      if (clock === 0) throw new Error('connection refused');
      return new Response(clock === 2 ? 'starting' : 'Sign in', {
        status: clock === 2 ? 503 : 200,
      });
    },
  });
  assert.equal(page.text, 'Sign in');
  assert.deepEqual(events, ['fetch', 'running', 'wait 2', 'fetch', 'running', 'wait 2', 'fetch']);
});

test('readiness caps the final request to the remaining overall budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let signal;
  let started;
  const secondRequest = new Promise((resolve) => {
    started = resolve;
  });
  const request = waitForWebLogin('http://fixture', {
    timeoutMs: 5,
    requestTimeoutMs: 4,
    pollMs: 3,
    wait: async (ms) => t.mock.timers.tick(ms),
    fetchImpl: async (url, options) => {
      if (Date.now() === 0) return new Response('starting', { status: 503 });
      signal = options.signal;
      started();
      return new Promise(() => {});
    },
  });
  const rejected = assert.rejects(request, /\/login not ready within 5ms;.*timed out after 2ms/);
  await secondRequest;
  t.mock.timers.tick(2);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('readiness caps the last poll and reports the last HTTP failure', async () => {
  let clock = 0;
  const waits = [];
  await assert.rejects(
    waitForWebLogin('http://fixture', {
      timeoutMs: 5,
      pollMs: 3,
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      fetchImpl: async () => new Response('starting', { status: 503 }),
    }),
    /\/login not ready within 5ms; last failure: HTTP 503/,
  );
  assert.deepEqual(waits, [3, 2]);
});

test('readiness stops probing when the container has exited', async () => {
  await assert.rejects(
    waitForWebLogin('http://fixture', {
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
      isRunning: () => false,
      wait: async () => assert.fail('must not poll a stopped container'),
    }),
    /container stopped; last failure: connection refused/,
  );
});
