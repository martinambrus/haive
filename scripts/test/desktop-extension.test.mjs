import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  controls,
  appURL,
  createController,
  encodeRequest,
  statusMessage,
  serviceHealth,
} from '../../docker/desktop-extension/ui/controller.js';

const installed = {
  installed: true,
  version: '1.2.3',
  healthy: true,
  services: [
    { Service: 'api', State: 'running', Health: 'healthy' },
    { Service: 'web', State: 'running', Health: 'reachable' },
  ],
  appUrl: 'http://localhost:3010',
};
function fixture(options) {
  const calls = [];
  const views = [];
  let response = { installed: false };
  const dd = {
    host: { platform: 'linux', openExternal: (url) => calls.push(['open', url]) },
    docker: {
      cli: {
        exec: async (...args) => {
          calls.push(args);
          return { stdout: args[0] === 'ps' ? 'a'.repeat(64) : 'engine-id\n' };
        },
      },
    },
    extension: {
      host: {
        cli: {
          exec: async (...args) => {
            calls.push(args);
            return { stdout: JSON.stringify(response) };
          },
        },
      },
    },
    desktopUI: {
      navigate: {
        viewContainerLogs: async (id) => calls.push(['logs', id]),
        viewContainers: async () => calls.push(['containers']),
      },
    },
  };
  const c = createController(dd, (view) => views.push(view), options);
  return {
    c,
    dd,
    calls,
    views,
    respond: (value) => {
      response = value;
    },
  };
}

test('unknown or failed status cannot enable mutations or app opening', () => {
  for (const state of [null, { error: 'unavailable' }]) {
    const c = controls(state, false, true);
    for (const action of ['install', 'start', 'stop', 'open'])
      assert.equal(c[action], false, action);
    assert.equal(c.status, true);
  }
});

const decode = (arg) =>
  JSON.parse(Buffer.from(arg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));

test('install and every start require explicit consent; status and logs do not', async () => {
  const f = fixture();
  await f.c.run('status');
  await assert.rejects(f.c.run('install'), /unavailable/);
  f.c.accept(true);
  f.respond(installed);
  await f.c.run('install', 'next');
  const request = f.calls
    .filter((call) => call[0] === 'haive-desktop')
    .map((call) => decode(call[1][0]))
    .find((request) => request.action === 'install');
  assert.deepEqual(request, {
    action: 'install',
    version: 'next',
    engine: 'engine-id',
    consent: 'accept-host-root',
  });
  assert.equal(f.views.at(-1).controls.install, false);
  f.respond({
    ...installed,
    services: [
      { Service: 'api', State: 'exited' },
      { Service: 'web', State: 'running', Health: 'unreachable' },
    ],
  });
  await f.c.run('status');
  f.c.accept(false);
  await assert.rejects(f.c.run('start'), /unavailable/);
  await f.c.run('stop');
  assert.ok(
    f.calls.some((call) => call[0] === 'haive-desktop' && decode(call[1][0]).action === 'stop'),
  );
});

test('unsupported versions refuse before invoking any command', async () => {
  const f = fixture();
  await f.c.run('status');
  f.c.accept(true);
  const before = f.calls.length;
  for (const version of ['main', '--force', '../escape', '', '1.2.3\n', '1.2.3;evil'])
    await assert.rejects(f.c.run('install', version));
  assert.equal(f.calls.length, before);
});

test('busy operation prevents duplicate execution and clears after failures', async () => {
  const f = fixture();
  await f.c.run('status');
  f.c.accept(true);
  let reject;
  const exec = f.dd.extension.host.cli.exec;
  f.dd.extension.host.cli.exec = (...args) =>
    decode(args[1][0]).action === 'install'
      ? new Promise((_, r) => {
          reject = r;
        })
      : exec(...args);
  const pending = f.c.run('install');
  await new Promise(setImmediate);
  assert.equal(f.views.at(-1).busy, true);
  const count = f.calls.length;
  await f.c.run('install');
  assert.equal(f.calls.length, count);
  reject({
    stdout: JSON.stringify({
      directory: '/home/test/haive_desktop',
      error: 'Installer failed safely.',
    }),
    stderr: 'must never be displayed',
  });
  await pending;
  const view = f.views.at(-1);
  assert.equal(view.busy, false);
  assert.equal(view.message, 'Installer failed safely.');
  assert.equal(view.controls.open, false);
  assert.ok(!JSON.stringify(view).includes('must never be displayed'));
});

test('Windows selects the native executable', async () => {
  const f = fixture();
  f.dd.host.platform = 'win32';
  await f.c.run('status');
  assert.equal(f.calls.at(-1)[0], 'haive-desktop.exe');
});

test('opening the app uses the actual port and existing first-run setup', async () => {
  const f = fixture();
  f.respond(installed);
  await f.c.run('status');
  f.c.open();
  assert.deepEqual(f.calls.at(-1), ['open', 'http://localhost:3010/setup']);
  for (const appUrl of [
    'https://example.com',
    'http://localhost:65536',
    'file:///tmp/x',
    'http://localhost:0',
    'http://localhost:3000/evil',
  ])
    assert.throws(() => appURL({ appUrl }));
});

test('logs navigate only to the extension install project', async () => {
  const f = fixture();
  await f.c.logs('worker');
  assert.ok(f.calls[0][1].includes('label=com.docker.compose.project=haive_desktop'));
  assert.ok(f.calls[0][1].includes('label=com.docker.compose.service=worker'));
  assert.deepEqual(f.calls.at(-1), ['logs', 'a'.repeat(64)]);
});

test('extension lifecycle owns no VM stack or data volumes', () => {
  const metadata = JSON.parse(
    readFileSync(new URL('../../docker/desktop-extension/metadata.json', import.meta.url)),
  );
  assert.equal(metadata.vm, undefined);
  assert.ok(metadata.host.binaries[0].windows[0].path.endsWith('.exe'));
});

test('install failures render folder recovery advice from resolved and rejected host results', async () => {
  const directory = '/home/test/haive_desktop';
  for (const reason of [
    'This release bundle does not support isolated published installs. Choose a newer release; no containers were changed.',
    'Cannot resolve the installed bundle. Docker Compose 2.24 or later is required.',
    'The installer failed. See the private operation log and fix the reported prerequisite or release error.',
  ]) {
    for (const rejected of [false, true]) {
      const f = fixture();
      await f.c.run('status');
      f.c.accept(true);
      const error = `${reason} Remove the folder "${directory}", then install again.`;
      const result = { stdout: JSON.stringify({ directory, error }), stderr: 'private details' };
      f.dd.extension.host.cli.exec = async () => {
        if (rejected) throw result;
        return result;
      };
      await f.c.run('install');
      const view = f.views.at(-1);
      assert.equal(view.message, error);
      assert.equal(view.state.directory, directory);
      assert.equal(view.busy, false);
      assert.ok(!JSON.stringify(view).includes('private details'));
    }
  }
});

test('host requests travel as quote-free base64url', () => {
  const request = {
    action: 'install',
    version: 'v0.2.0',
    engine: 'e:1',
    consent: 'accept-host-root',
  };
  const arg = encodeRequest(request);
  assert.match(arg, /^[A-Za-z0-9_-]+$/);
  const b64 = arg.replace(/-/g, '+').replace(/_/g, '/');
  assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), request);
});

const flush = async () => {
  await new Promise(setImmediate);
};
const hostActions = (f) =>
  f.calls.filter((call) => call[0] === 'haive-desktop').map((call) => decode(call[1][0]).action);

test('failed Start refreshes services and controls without losing the reason', async () => {
  for (const rejected of [false, true]) {
    const f = fixture();
    f.respond({ ...installed, healthy: false, services: [] });
    await f.c.run('status');
    f.c.accept(true);
    const exec = f.dd.extension.host.cli.exec;
    f.dd.extension.host.cli.exec = async (...args) => {
      if (decode(args[1][0]).action === 'start') {
        const result = { stdout: JSON.stringify({ error: 'Port 3010 is held by another app.' }) };
        f.respond({
          ...installed,
          services: [{ Service: 'web', State: 'running', Health: 'reachable' }],
        });
        if (rejected) throw result;
        return result;
      }
      return exec(...args);
    };
    await f.c.run('start');
    const view = f.views.at(-1);
    assert.equal(hostActions(f).at(-1), 'status');
    assert.equal(view.state.services[0].State, 'running');
    assert.equal(view.controls.start, false);
    assert.equal(view.controls.stop, true);
    assert.equal(view.controls.open, true);
    assert.equal(view.message, 'Port 3010 is held by another app.');
    f.c.dispose();
  }
});

test('visible polling uses five seconds while starting and thirty seconds otherwise', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.c.dispose());
  f.respond({
    ...installed,
    healthy: false,
    services: [{ Service: 'api', State: 'created', Health: '' }],
  });
  await f.c.run('status');
  assert.match(f.views.at(-1).statusMessage, /Starting…/);
  f.c.accept(true);
  assert.equal(f.views.at(-1).controls.start, true);
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(hostActions(f).length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(hostActions(f).length, 2);
  f.respond(installed);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(hostActions(f).length, 3);
  t.mock.timers.tick(29999);
  await flush();
  assert.equal(hostActions(f).length, 3);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(hostActions(f).length, 4);
});

test('status polls during Start without enabling actions or overwriting completion with an old poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.c.dispose());
  f.respond({ ...installed, healthy: false, services: [] });
  await f.c.run('status');
  f.c.accept(true);
  const exec = f.dd.extension.host.cli.exec;
  let finishStart, finishPoll;
  f.dd.extension.host.cli.exec = (...args) => {
    const action = decode(args[1][0]).action;
    if (action === 'start')
      return new Promise((resolve) => {
        finishStart = resolve;
      });
    if (!finishPoll)
      return new Promise((resolve) => {
        finishPoll = resolve;
      });
    return exec(...args);
  };
  const start = f.c.run('start');
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.ok(finishPoll);
  assert.equal(f.views.at(-1).busy, true);
  finishStart({ stdout: JSON.stringify(installed) });
  f.respond(installed);
  await start;
  finishPoll({
    stdout: JSON.stringify({
      ...installed,
      healthy: false,
      services: [{ Service: 'api', State: 'created' }],
    }),
  });
  await flush();
  assert.equal(f.views.at(-1).state.healthy, true);
  assert.equal(f.views.at(-1).controls.start, false);
});

test('hidden and disposed tabs stop polling; returning visible refreshes immediately', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new EventTarget();
  doc.hidden = false;
  const f = fixture({ document: doc });
  t.after(() => f.c.dispose());
  await f.c.run('status');
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(hostActions(f).length, 1);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(hostActions(f).length, 2);
  f.c.dispose();
  t.mock.timers.tick(60000);
  await flush();
  doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  assert.equal(hostActions(f).length, 2);
});

test('failed follow-up status preserves last service rows and reports status unavailable', async () => {
  const f = fixture();
  f.respond({ ...installed, healthy: false, services: [{ Service: 'web', State: 'exited' }] });
  await f.c.run('status');
  f.c.accept(true);
  f.dd.extension.host.cli.exec = async (...args) => {
    throw {
      stdout: JSON.stringify({
        error:
          decode(args[1][0]).action === 'start'
            ? 'Compose failed. Read operation log.'
            : 'Cannot read Compose status.',
      }),
      stderr: 'secret',
    };
  };
  await f.c.run('start');
  const view = f.views.at(-1);
  assert.equal(view.state.services[0].State, 'exited');
  assert.match(view.statusMessage, /Cannot read Compose status/);
  assert.match(view.message, /Compose failed/);
  assert.equal(view.controls.start, false);
  assert.equal(view.controls.status, true);
  assert.ok(!JSON.stringify(view).includes('secret'));
  f.c.dispose();
});

test('created containers after a failed start can be retried after correcting ports', async () => {
  const f = fixture();
  f.respond({ ...installed, healthy: false, services: [] });
  await f.c.run('status');
  f.c.accept(true);
  const exec = f.dd.extension.host.cli.exec;
  f.dd.extension.host.cli.exec = async (...args) => {
    if (decode(args[1][0]).action === 'start') {
      f.respond({ ...installed, healthy: false, services: [{ Service: 'web', State: 'created' }] });
      return { stdout: JSON.stringify({ error: 'Port 3010 is held by another app.' }) };
    }
    return exec(...args);
  };
  await f.c.run('start');
  assert.equal(f.views.at(-1).controls.start, true);
  assert.equal(f.views.at(-1).controls.stop, false);
  assert.equal(f.views.at(-1).state.services[0].State, 'created');
  f.c.dispose();
});

test('unhealthy running probes poll every five seconds without overlapping reads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.c.dispose());
  f.respond({
    ...installed,
    healthy: false,
    services: [{ Service: 'api', State: 'running', Health: 'unhealthy' }],
  });
  await f.c.run('status');
  const exec = f.dd.extension.host.cli.exec;
  let finish;
  f.dd.extension.host.cli.exec = (...args) =>
    new Promise((resolve) => {
      finish = async () => resolve(await exec(...args));
    });
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(hostActions(f).length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.ok(finish);
  t.mock.timers.tick(90000);
  await flush();
  assert.equal(hostActions(f).length, 1);
  f.respond(installed);
  await finish();
  await flush();
  assert.equal(hostActions(f).length, 2);
  assert.equal(f.views.at(-1).message, '');
});

test('disposing a controller prevents late poll replies from rendering', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.c.run('status');
  let finish;
  f.dd.extension.host.cli.exec = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  t.mock.timers.tick(30000);
  await flush();
  f.c.dispose();
  const count = f.views.length;
  finish({ stdout: JSON.stringify(installed) });
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(f.views.length, count);
});

test('starting progress counts the migration one-shot but not stopped services', () => {
  assert.equal(
    statusMessage({
      installed: true,
      services: [
        { Service: 'api', State: 'created' },
        { Service: 'postgres', State: 'running', Health: 'healthy' },
        { Service: 'db-migrate', State: 'exited', ExitCode: 0 },
        { Service: 'worker', State: 'exited', ExitCode: 0, Health: 'healthy' },
      ],
    }),
    'Starting… 2/4 services ready. See service progress below.',
  );
});

test('controls follow per-service states rather than aggregate readiness', () => {
  const cases = [
    ['empty', [], false, true, false],
    ['created', [{ Service: 'web', State: 'created' }], false, true, false],
    ['paused', [{ Service: 'web', State: 'paused' }], true, true, false],
    ['stopped', [{ Service: 'web', State: 'exited', Health: 'reachable' }], false, true, false],
    [
      'running unhealthy',
      [{ Service: 'web', State: 'running', Health: 'unreachable' }],
      true,
      true,
      false,
    ],
    [
      'web ready, API down',
      [
        { Service: 'web', State: 'running', Health: 'reachable' },
        { Service: 'api', State: 'exited' },
      ],
      true,
      true,
      true,
    ],
    [
      'all ready',
      [
        { Service: 'web', State: 'running', Health: 'reachable' },
        { Service: 'api', State: 'running', Health: 'healthy' },
        { Service: 'worker', State: 'running' },
        { Service: 'db-migrate', State: 'exited', ExitCode: 0 },
      ],
      true,
      false,
      true,
    ],
    [
      'migration failed',
      [
        { Service: 'web', State: 'running', Health: 'reachable' },
        { Service: 'db-migrate', State: 'exited', ExitCode: 1 },
      ],
      true,
      true,
      true,
    ],
    [
      'restarting',
      [{ Service: 'web', State: 'restarting', Health: 'reachable' }],
      true,
      true,
      false,
    ],
  ];
  for (const [name, services, stop, start, open] of cases) {
    const state = { ...installed, services };
    assert.deepEqual(
      controls(state, false, true),
      { install: false, stop, start, open, status: true, logs: true },
      name,
    );
    assert.equal(controls(state, false, false).start, false, name);
    for (const action of ['install', 'start', 'stop', 'open'])
      assert.equal(controls(state, true, true)[action], false, name);
  }
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('consent survives installed tab reload, unchecking, and separate viewers', async () => {
  const storage = memoryStorage();
  const f = fixture({ storage });
  f.respond({ ...installed, directory: '/viewer/haive_desktop' });
  await f.c.run('status');
  assert.equal(f.views.at(-1).accepted, false);
  f.c.accept(true);
  f.c.dispose();
  const reload = fixture({ storage });
  reload.respond({ ...installed, directory: '/viewer/haive_desktop' });
  await reload.c.run('status');
  assert.equal(reload.views.at(-1).accepted, true);
  const separate = fixture({ storage: memoryStorage() });
  separate.respond(installed);
  await separate.c.run('status');
  assert.equal(separate.views.at(-1).accepted, false);
  reload.c.accept(false);
  reload.c.dispose();
  const unticked = fixture({ storage });
  unticked.respond({ ...installed, directory: '/viewer/haive_desktop' });
  await unticked.c.run('status');
  assert.equal(unticked.views.at(-1).accepted, false);
  separate.c.dispose();
  unticked.c.dispose();
});

test('a fresh install never inherits stored consent; storage failures default unticked', async () => {
  const storage = memoryStorage();
  const f = fixture({ storage });
  f.respond({ ...installed, directory: '/viewer/haive_desktop' });
  await f.c.run('status');
  f.c.accept(true);
  f.c.dispose();
  const fresh = fixture({ storage });
  await fresh.c.run('status');
  assert.equal(fresh.views.at(-1).accepted, false);
  assert.equal(fresh.views.at(-1).controls.install, false);
  fresh.c.dispose();
  for (const store of [
    null,
    {
      getItem() {
        throw Error('unavailable');
      },
      setItem() {
        throw Error('unavailable');
      },
      removeItem() {
        throw Error('unavailable');
      },
    },
  ]) {
    const next = fixture({ storage: store });
    next.respond(installed);
    await next.c.run('status');
    assert.equal(next.views.at(-1).accepted, false);
    next.c.accept(true);
    assert.equal(next.views.at(-1).accepted, true);
    next.c.dispose();
  }
});

test('health labels identify extension probes', () => {
  assert.equal(serviceHealth({ Service: 'api', Health: 'healthy' }), 'healthy (extension probe)');
  assert.equal(
    serviceHealth({ Service: 'web', Health: 'reachable' }),
    'reachable (extension probe)',
  );
  assert.equal(serviceHealth({ Service: 'postgres', Health: 'healthy' }), 'healthy');
});

test('port move notice survives follow-up status and automatic polls', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.c.dispose());
  f.respond({ ...installed, services: [] });
  await f.c.run('status');
  f.c.accept(true);
  const exec = f.dd.extension.host.cli.exec;
  f.dd.extension.host.cli.exec = async (...args) => {
    if (decode(args[1][0]).action === 'start') {
      f.respond({ ...installed, appUrl: 'http://localhost:3012' });
      return {
        stdout: JSON.stringify({
          ...installed,
          notice: 'web moved to 3012 because 3010 is in use',
        }),
      };
    }
    return exec(...args);
  };
  await f.c.run('start');
  assert.match(f.views.at(-1).statusMessage, /web moved to 3012 because 3010 is in use/);
  t.mock.timers.tick(30000);
  await flush();
  assert.match(f.views.at(-1).statusMessage, /web moved to 3012/);
  f.c.open();
  assert.deepEqual(f.calls.at(-1), ['open', 'http://localhost:3012/setup']);
});

test('stored installed consent restores after an initial status failure', async () => {
  const storage = memoryStorage();
  const prior = fixture({ storage });
  prior.respond(installed);
  await prior.c.run('status');
  prior.c.accept(true);
  prior.c.dispose();
  const next = fixture({ storage });
  next.respond({ error: 'Status temporarily unavailable' });
  await next.c.run('status');
  assert.equal(next.views.at(-1).accepted, false);
  next.respond(installed);
  await next.c.run('status');
  assert.equal(next.views.at(-1).accepted, true);
  next.c.dispose();
});

test('stored consent is scoped to engine and directory and carries through a fresh explicit install', async () => {
  const storage = memoryStorage();
  const f = fixture({ storage });
  const local = { ...installed, directory: '/viewer/haive_desktop' };
  f.respond({ installed: false, directory: local.directory });
  await f.c.run('status');
  f.c.accept(true);
  f.respond(local);
  await f.c.run('install');
  f.c.dispose();
  const reload = fixture({ storage });
  reload.respond(local);
  await reload.c.run('status');
  assert.equal(reload.views.at(-1).accepted, true);
  reload.c.dispose();
  const moved = fixture({ storage });
  moved.respond({ ...local, directory: '/another/haive_desktop' });
  await moved.c.run('status');
  assert.equal(moved.views.at(-1).accepted, false);
  moved.c.dispose();
  const engine = fixture({ storage });
  engine.respond(local);
  engine.dd.docker.cli.exec = async () => ({ stdout: 'another-engine' });
  await engine.c.run('status');
  assert.equal(engine.views.at(-1).accepted, false);
  engine.c.dispose();
});

test('Start and Install completion poll negative running probes quickly for a bounded window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const action of ['start', 'install']) {
    const f = fixture();
    const pending = {
      ...installed,
      healthy: false,
      services: [
        { Service: 'api', State: 'running', Health: 'unhealthy' },
        { Service: 'web', State: 'running', Health: 'reachable' },
      ],
    };
    f.respond(action === 'start' ? pending : { installed: false });
    await f.c.run('status');
    f.c.accept(true);
    f.respond(pending);
    await f.c.run(action);
    assert.match(f.views.at(-1).statusMessage, /Starting… 1\/2 services ready/);
    const count = hostActions(f).length;
    t.mock.timers.tick(4999);
    await flush();
    assert.equal(hostActions(f).length, count);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(hostActions(f).length, count + 1);
    // The production five-minute bound expires despite repeated successful reads.
    t.mock.timers.tick(295000);
    await flush();
    const bounded = hostActions(f).length;
    t.mock.timers.tick(29999);
    await flush();
    assert.equal(hostActions(f).length, bounded);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(hostActions(f).length, bounded + 1);
    f.c.dispose();
  }
});

test('created and restarting services fall back to thirty seconds after the fast window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const state of ['created', 'restarting']) {
    const f = fixture({ fastWindowMs: 10000 });
    f.respond({ ...installed, services: [{ Service: 'api', State: state }] });
    await f.c.run('status');
    t.mock.timers.tick(10000);
    await flush();
    const count = hostActions(f).length;
    t.mock.timers.tick(29999);
    await flush();
    assert.equal(hostActions(f).length, count);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(hostActions(f).length, count + 1);
    f.c.dispose();
  }
});

test('three consecutive status errors back off to thirty seconds and success restores fast polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.after(() => f.c.dispose());
  const pending = { ...installed, services: [{ Service: 'api', State: 'created' }] };
  f.respond(pending);
  await f.c.run('status');
  f.respond({ error: 'Status read failed.' });
  for (let i = 0; i < 3; i++) {
    const count = hostActions(f).length;
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(hostActions(f).length, count + 1);
  }
  const count = hostActions(f).length;
  t.mock.timers.tick(29999);
  await flush();
  assert.equal(hostActions(f).length, count);
  f.respond(pending);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(hostActions(f).length, count + 1);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(hostActions(f).length, count + 2);
});

test('idle status and move notices appear in only the status summary', async () => {
  const f = fixture();
  f.respond({ ...installed, services: [] });
  await f.c.run('status');
  f.c.accept(true);
  f.respond({ ...installed, notice: 'web moved to 3010 because 3000 is in use' });
  await f.c.run('start');
  assert.equal(f.views.at(-1).message, '');
  assert.match(f.views.at(-1).statusMessage, /Haive is ready.*web moved/);
  await f.c.run('status');
  assert.equal(f.views.at(-1).message, '');
  f.c.dispose();
});
