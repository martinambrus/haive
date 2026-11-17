import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  controls,
  appURL,
  createController,
} from '../../docker/desktop-extension/ui/controller.js';

const installed = {
  installed: true,
  version: '1.2.3',
  healthy: true,
  appUrl: 'http://localhost:3010',
};
function fixture() {
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
  const c = createController(dd, (view) => views.push(view));
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

test('install and every start require explicit consent; status and logs do not', async () => {
  const f = fixture();
  await f.c.run('status');
  await assert.rejects(f.c.run('install'), /unavailable/);
  f.c.accept(true);
  f.respond(installed);
  await f.c.run('install', 'next');
  const request = JSON.parse(f.calls.at(-1)[1][0]);
  assert.deepEqual(request, {
    action: 'install',
    version: 'next',
    engine: 'engine-id',
    consent: 'accept-host-root',
  });
  assert.equal(f.views.at(-1).controls.install, false);
  f.c.accept(false);
  await assert.rejects(f.c.run('start'), /unavailable/);
  await f.c.run('stop');
  assert.equal(JSON.parse(f.calls.at(-1)[1][0]).action, 'stop');
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
  f.dd.extension.host.cli.exec = () =>
    new Promise((_, r) => {
      reject = r;
    });
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
