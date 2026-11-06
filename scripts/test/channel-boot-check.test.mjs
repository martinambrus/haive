import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';

const IDS = Object.fromEntries(
  ['api', 'worker', 'web'].map((key, i) => [key, `sha256:${String(i + 1).repeat(64)}`]),
);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const moduleRow = (id) => ({ id, packageName: `@haive/module-${id}`, version: '1.0.0' });

function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hbc-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = {
    schema: 1,
    tag: 'v9.9.9',
    commit: 'a'.repeat(40),
    channel: 'test',
    version: '9.9.9',
    platform: 'linux/amd64',
    imageStore: { Driver: 'overlayfs', DriverStatus: [] },
    images: Object.fromEntries(
      Object.entries(IDS).map(([key, id]) => [
        key,
        { ref: `example.test/haive-test-${key}:9.9.9`, id, built: key !== 'web' },
      ]),
    ),
    modules: [{ packageName: '@haive/module-statistics', source: 'local', webParts: ['web'] }],
  };
  config.editRecord?.(record);
  const path = join(dir, 'record.json');
  writeFileSync(path, config.raw ?? JSON.stringify(record));
  const calls = [];
  const logs = [];
  const requests = [];
  const created = { containers: [], volumes: [], networks: [], images: [] };
  const removed = { containers: [], volumes: [], networks: [], images: [] };
  const secrets = new Set();
  const envFiles = new Set();
  const controller = new AbortController();
  let clock = 0;
  let prefix;
  let late;
  const runner = async (cmd, args, options) => {
    calls.push({ cmd, args });
    assert.equal(cmd, 'docker');
    assert.ok(options.timeout > 0);
    if (args[0] === 'image' && args[1] === 'inspect') {
      const host = Object.keys(record.images).find((key) => record.images[key].ref === args.at(-1));
      if (!host && config.dependencyInspectError)
        return { status: 1, stderr: config.dependencyInspectError };
      if (!host && config.dependencyInspectCaptureError)
        return { status: 0, error: new Error('inspect transport failed') };
      if (!host && config.pullDependencies) return { status: 1, stderr: 'No such image' };
      return ok(config.retagged === host ? `sha256:${'f'.repeat(64)}` : IDS[host]);
    }
    if (args[0] === 'image' && args[1] === 'ls') {
      return config.dependencyListFailure
        ? { status: 1, stderr: 'daemon unavailable' }
        : ok(config.pullDependencies ? '' : `sha256:${'4'.repeat(64)}`);
    }
    if (args[0] === 'pull') {
      if (config.pullFailure) return { status: 1, stderr: 'pull refused' };
      created.images.push(args.at(-1));
      if (config.abortPull) {
        controller.abort();
        return { status: null, error: new Error('interrupted') };
      }
      return ok();
    }
    if (args[0] === 'image' && args[1] === 'rm') {
      if (config.pullFailure)
        return { status: 1, stderr: 'Error response from daemon: No such image: ' + args.at(-1) };
      removed.images.push(args.at(-1));
      return ok();
    }
    if (args[0] === 'network' && args[1] === 'create') {
      prefix = args.at(-1);
      assert.match(prefix, /^hbc-test-[a-z0-9]+$/);
      if (config.createFailure === 'network') return { status: 1, stderr: 'create refused' };
      created.networks.push(prefix);
      if (config.abortNetwork) {
        controller.abort();
        return { status: null, error: new Error('interrupted') };
      }
      return ok(prefix);
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      assert.ok(args.at(-1).startsWith(`${prefix}-`));
      if (config.createFailure === 'volume') return { status: 1, stderr: 'create refused' };
      created.volumes.push(args.at(-1));
      return ok(args.at(-1));
    }
    if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1];
      assert.ok(name.startsWith(`${prefix}-`));
      const suffix = name.slice(prefix.length + 1);
      if (['api', 'migrate', 'worker'].includes(suffix)) {
        const key = suffix === 'migrate' ? 'api' : suffix;
        assert.ok(args.includes(record.images[key].id), `${suffix} uses its recorded image id`);
        assert.ok(!args.includes(record.images[key].ref), `${suffix} does not run by ref`);
        assert.equal(args[args.indexOf('--pull') + 1], 'never');
        assert.equal(args[args.indexOf('--platform') + 1], record.platform);
      }
      if (config.createFailure === 'container') return { status: 1, stderr: 'create refused' };
      if (config.timeoutCreateLate && name.endsWith('-api')) {
        late = name;
        return {
          status: null,
          error: Object.assign(new Error('command timed out'), { code: 'ETIMEDOUT' }),
        };
      }
      if (config.abortCreateLate && name.endsWith('-api')) {
        late = name;
        controller.abort();
        return { status: null, error: new Error('interrupted'), stdout: '', stderr: '' };
      }
      if (config.abortBeforeCreate) {
        controller.abort();
        return { status: null, error: new Error('interrupted') };
      }
      created.containers.push(name);
      assert.ok(!args.includes('--privileged'));
      assert.ok(!args.join(' ').includes('/var/run/docker.sock'));
      assert.ok(!args.includes('--network=host'));
      assert.equal(args[args.indexOf('--network') + 1], prefix);
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--env-file') continue;
        const file = args[i + 1];
        assert.equal(statSync(file).mode & 0o777, 0o600);
        assert.ok(!file.startsWith(new URL('../..', import.meta.url).pathname));
        envFiles.add(file);
        for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
          const [key, ...rest] = line.split('=');
          if (/PASSWORD|ENCRYPTION_KEY|SETUP_TOKEN/.test(key)) secrets.add(rest.join('='));
        }
      }
      if (name.endsWith('-worker') && config.abort) controller.abort();
      if (name.endsWith('-api') && config.bootFailure)
        return { status: 1, stdout: '', stderr: `failed ${[...secrets].join(' ')}` };
      if (config.abortDuringCreate && name.endsWith('-api')) {
        controller.abort();
        return { status: null, error: new Error('interrupted'), stdout: '', stderr: '' };
      }
      return ok(name);
    }
    if (['container', 'network', 'volume'].includes(args[0]) && args[1] === 'inspect') {
      return created[`${args[0]}s`].includes(args.at(-1))
        ? ok('{}')
        : { status: 1, stderr: 'No such object' };
    }
    if (args[0] === 'port') return ok('127.0.0.1:43210\n');
    if (args[0] === 'exec') return config.pgTimeout ? { status: 1 } : ok('PONG');
    if (args[0] === 'inspect') {
      const name = args.at(-1);
      const state = name.endsWith('-migrate')
        ? { Status: 'exited', Running: false, ExitCode: config.migrateFailure ? 1 : 0 }
        : { Status: 'running', Running: true, ExitCode: 0 };
      return ok(JSON.stringify(state));
    }
    if (args[0] === 'logs') return ok(`boot log ${[...secrets].join(' ')}`);
    if (args[0] === 'rm') {
      if (args.at(-1) === late) created.containers.push(late);
      else if (!created.containers.includes(args.at(-1)))
        return { status: 1, stderr: 'No such container' };
      removed.containers.push(args.at(-1));
      if (config.abortCleanup) controller.abort();
      return config.cleanupFailure ? { status: 1, stderr: 'cleanup refused' } : ok();
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      removed.volumes.push(args.at(-1));
      return ok();
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      removed.networks.push(args.at(-1));
      return ok();
    }
    throw new Error(`unexpected docker call ${args.join(' ')}`);
  };
  const request = async (url, options = {}) => {
    requests.push({ url, options });
    assert.equal(new URL(url).origin, 'http://127.0.0.1:43210');
    assert.equal(new Headers(options.headers).get('Origin'), null);
    assert.ok(options.signal);
    if (url.endsWith('/health')) {
      if (config.bootTimeout) throw new Error('not ready');
      return Response.json({ status: 'ok' });
    }
    if (url.endsWith('/auth/register')) {
      const body = JSON.parse(options.body);
      assert.ok(body.password.length >= 12);
      secrets.add(body.password);
      assert.ok(secrets.has(body.setupToken));
      assert.equal(options.method, 'POST');
      if (config.registerFailure) return Response.json({}, { status: 403 });
      secrets.add('fake-access-cookie');
      return Response.json(
        { user: { role: 'admin' } },
        {
          status: 201,
          headers: { 'Set-Cookie': 'haive_access=fake-access-cookie; Secure; HttpOnly; Path=/' },
        },
      );
    }
    assert.ok(url.endsWith('/modules/loaded'));
    assert.equal(new Headers(options.headers).get('Cookie'), 'haive_access=fake-access-cookie');
    if (config.abortReport) {
      controller.abort();
      throw new Error('fetch interrupted');
    }
    if (
      config.transientReport &&
      requests.filter((r) => r.url.endsWith('/modules/loaded')).length === 1
    )
      throw new Error('connection reset');
    if (config.reportFetchError)
      throw new TypeError('fetch failed', {
        cause: new Error('getaddrinfo ENOTFOUND api.invalid'),
      });
    if (config.reportFailure) return Response.json({}, { status: 500 });
    return Response.json({
      api: { modules: (config.api ?? ['statistics']).map(moduleRow) },
      worker: config.noWorker
        ? null
        : {
            at: new Date().toISOString(),
            modules: (config.worker ?? ['statistics']).map(moduleRow),
          },
      ...config.report,
    });
  };
  return {
    path,
    calls,
    logs,
    requests,
    created,
    removed,
    async check(args = ['--record', path, '--timeout-ms', '40']) {
      const { run } = await import('../channel-boot-check.mjs');
      const status = await run(args, {
        runner,
        request,
        say: (line) => logs.push(line),
        signal: controller.signal,
        now: () => clock,
        wait: async () => {
          clock += 10;
        },
      });
      for (const kind of Object.keys(created))
        assert.deepEqual([...removed[kind]].sort(), [...created[kind]].sort());
      for (const file of envFiles) {
        assert.ok(!existsSync(file));
        assert.ok(!existsSync(dirname(file)));
      }
      const printed = logs.join('\n');
      const argv = JSON.stringify(calls);
      for (const secret of secrets) {
        assert.ok(!printed.includes(secret), 'secret printed');
        assert.ok(!argv.includes(secret), 'secret in argv');
      }
      return status;
    },
  };
}

test('missing record argument exits 2 before creating anything', async (t) => {
  const f = fixture(t);
  assert.equal(await f.check([]), 2);
  assert.equal(f.calls.length, 0);
});

test('missing record file exits 2', async (t) => {
  const f = fixture(t);
  assert.equal(await f.check(['--record', join(dirname(f.path), 'missing.json')]), 2);
});

for (const [label, config] of [
  ['invalid JSON', { raw: '{' }],
  [
    'wrong schema',
    {
      editRecord: (r) => {
        r.schema = 3;
      },
    },
  ],
  [
    'schema 2 without builder',
    {
      editRecord: (r) => {
        r.schema = 2;
        delete r.images.builder;
      },
    },
  ],
  [
    'missing worker',
    {
      editRecord: (r) => {
        delete r.images.worker;
      },
    },
  ],
  [
    'invalid image id',
    {
      editRecord: (r) => {
        r.images.api.id = 'not-an-id';
      },
    },
  ],
  [
    'missing web ref',
    {
      editRecord: (r) => {
        delete r.images.web.ref;
      },
    },
  ],
  [
    'invalid channel',
    {
      editRecord: (r) => {
        r.channel = '../oops';
      },
    },
  ],
  [
    'duplicate module id',
    {
      editRecord: (r) => {
        r.modules.push(r.modules[0]);
      },
    },
  ],
  [
    'invalid registry spec',
    {
      editRecord: (r) => {
        r.modules.push({ packageName: '@haive-module/foo', source: 'registry' });
      },
    },
  ],
]) {
  test(`bad record: ${label} exits 2`, async (t) => {
    const f = fixture(t, config);
    assert.equal(await f.check(), 2);
    assert.equal(f.calls.length, 0);
  });
}

test('equal sets exit 0, with local and registry modules; resources removed', async (t) => {
  const f = fixture(t, {
    editRecord: (r) => {
      r.modules.push({
        packageName: '@haive-module/paid',
        source: 'registry',
        version: '1.2.3',
        webParts: [],
      });
    },
    api: ['paid', 'statistics'],
    worker: ['statistics', 'paid'],
  });
  assert.equal(await f.check(), 0);
  assert.equal(f.created.containers.length, 5);
  const runs = f.calls.filter((c) => c.args[0] === 'run').map((c) => c.args);
  assert.equal(runs.filter((args) => args.includes('-p')).length, 1);
  assert.ok(runs.some((args) => args.includes('127.0.0.1::3001')));
  assert.ok(runs.some((args) => args.includes('pgvector/pgvector:pg18')));
  assert.ok(runs.some((args) => args.includes('redis:8.4-alpine') && args.includes('noeviction')));
  assert.ok(
    runs.some(
      (args) => args.includes(IDS.api) && args.includes('packages/database/dist/migrate/index.js'),
    ),
  );
  assert.ok(runs.some((args) => args.includes(IDS.worker)));
  assert.ok(!runs.some((args) => args.includes(IDS.web)));
  assert.match(f.logs.join('\n'), /passed/);
});

test('extra api id exits 1 and prints one OFFENDER; cleanup ran', async (t) => {
  const f = fixture(t, { api: ['statistics', 'extra'] });
  assert.equal(await f.check(), 1);
  assert.deepEqual(
    f.logs.filter((l) => l.startsWith('OFFENDER')),
    ['OFFENDER api loaded extra extra'],
  );
});

test('missing worker id exits 1 and prints one OFFENDER; cleanup ran', async (t) => {
  const f = fixture(t, { worker: [] });
  assert.equal(await f.check(), 1);
  assert.deepEqual(
    f.logs.filter((l) => l.startsWith('OFFENDER')),
    ['OFFENDER worker loaded missing statistics'],
  );
});

for (const key of ['api', 'worker']) {
  test(`retagged ${key} image exits 2 before boot`, async (t) => {
    const f = fixture(t, { retagged: key });
    assert.equal(await f.check(), 2);
    assert.equal(f.created.containers.length, 0);
    assert.match(f.logs.join('\n'), new RegExp(`${key} .*recorded id`));
  });
}

for (const mode of [
  'bootTimeout',
  'pgTimeout',
  'noWorker',
  'bootFailure',
  'migrateFailure',
  'registerFailure',
  'reportFailure',
  'abort',
  'abortDuringCreate',
  'abortNetwork',
  'abortCleanup',
]) {
  test(`${mode}: exits 2, scrubs secrets, removes every created resource`, async (t) => {
    const f = fixture(t, { [mode]: true });
    assert.equal(await f.check(), 2);
    assert.ok(f.created.networks.length > 0);
    assert.ok(f.logs.some((line) => /hbc-test-/.test(line)));
    if (['bootTimeout', 'pgTimeout', 'noWorker'].includes(mode)) {
      assert.match(f.logs.join('\n'), /timed out/);
      assert.match(f.logs.join('\n'), /boot log/);
    }
  });
}

test('a transient module-report network error retries and exits 0', async (t) => {
  const f = fixture(t, { transientReport: true });
  assert.equal(await f.check(), 0);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/modules/loaded')).length, 2);
});

test('abort during module-report fetch exits 2 without retrying', async (t) => {
  const f = fixture(t, { abortReport: true });
  assert.equal(await f.check(), 2);
  assert.equal(f.requests.filter((r) => r.url.endsWith('/modules/loaded')).length, 1);
  assert.match(f.logs.join('\n'), /interrupted/);
});

for (const kind of ['network', 'volume', 'container']) {
  test(`failed ${kind} create does not remove or report a nonexistent resource`, async (t) => {
    const f = fixture(t, { createFailure: kind });
    assert.equal(await f.check(), 2);
    assert.doesNotMatch(f.logs.join('\n'), /leftover/);
    assert.match(f.logs.join('\n'), /create refused/);
    const failed = f.calls.find(({ args }) =>
      kind === 'container' ? args[0] === 'run' : args[0] === kind && args[1] === 'create',
    ).args;
    const name = kind === 'container' ? failed[failed.indexOf('--name') + 1] : failed.at(-1);
    assert.ok(
      !f.calls.some(
        ({ args }) =>
          args.at(-1) === name &&
          (kind === 'container' ? args[0] === 'rm' : args[0] === kind && args[1] === 'rm'),
      ),
    );
    assert.ok(!f.logs.includes(`channel-boot-check: removed ${kind} ${name}`));
  });
}

test('abort before container creation attempts cleanup without claiming removal', async (t) => {
  const f = fixture(t, { abortBeforeCreate: true });
  assert.equal(await f.check(), 2);
  assert.doesNotMatch(f.logs.join('\n'), /leftover/);
  const attempted = f.calls.find(({ args }) => args[0] === 'run').args;
  const name = attempted[attempted.indexOf('--name') + 1];
  assert.ok(f.calls.some(({ args }) => args[0] === 'rm' && args.at(-1) === name));
  assert.ok(!f.logs.includes(`channel-boot-check: removed container ${name}`));
});

test('abort while the daemon is still creating a container still removes it', async (t) => {
  const f = fixture(t, { abortCreateLate: true });
  assert.equal(await f.check(), 2);
  assert.ok(f.removed.containers.some((name) => name.endsWith('-api')));
});

test('a cleanup failure prevents a successful verdict', async (t) => {
  const f = fixture(t, { cleanupFailure: true });
  assert.equal(await f.check(), 2);
  assert.match(f.logs.join('\n'), /cleanup.*hbc-test-/);
});

test('malformed report exits 2 rather than claiming empty sets match', async (t) => {
  const f = fixture(t, { report: { api: { modules: [{ id: 'invalid/id' }] } } });
  assert.equal(await f.check(), 2);
});

test('dependency images pulled by this run are removed too', async (t) => {
  const f = fixture(t, { pullDependencies: true });
  assert.equal(await f.check(), 0);
  assert.deepEqual(f.created.images, ['pgvector/pgvector:pg18', 'redis:8.4-alpine']);
});

test('pre-existing dependency images are never pulled or removed', async (t) => {
  const f = fixture(t);
  assert.equal(await f.check(), 0);
  assert.deepEqual(f.created.images, []);
  assert.deepEqual(f.removed.images, []);
  assert.ok(!f.calls.some(({ args }) => args[0] === 'pull'));
});

for (const [label, config] of [
  ['transient failure', { dependencyInspectError: 'daemon temporarily unavailable' }],
  ['misleading absence message', { dependencyInspectError: 'No such image' }],
  [
    'transient failure with an empty listing',
    { dependencyInspectError: 'daemon temporarily unavailable', pullDependencies: true },
  ],
  ['capture error', { dependencyInspectCaptureError: true }],
  ['failed absence check', { pullDependencies: true, dependencyListFailure: true }],
]) {
  test(`dependency inspect ${label}: exit 2 without pull or image removal`, async (t) => {
    const f = fixture(t, config);
    assert.equal(await f.check(), 2);
    assert.deepEqual(f.created.images, []);
    assert.deepEqual(f.removed.images, []);
    assert.ok(!f.calls.some(({ args }) => args[0] === 'pull'));
    assert.equal(f.created.networks.length, 0);
  });
}

for (const cli of ['channel-boot-check', 'publish-channel']) {
  for (const code of ['EPIPE', 'EIO', 'EACCES']) {
    test(`${cli} CLI stdout ${code} before abort ${code === 'EACCES' ? 'throws' : 'is non-fatal'}`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'stdout-control-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const preload = join(dir, 'stdout-error.mjs');
      writeFileSync(
        preload,
        `process.stdout.write = () => process.stdout.emit('error', Object.assign(new Error('stdout control ${code}'), {code: '${code}'}));`,
      );
      const result = spawnSync(
        process.execPath,
        ['--import', preload, new URL(`../${cli}.mjs`, import.meta.url).pathname, '--help'],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(result.signal, null);
      // Boot-check has no --help flag and normally refuses it with exit 2.
      const normalStatus = cli === 'channel-boot-check' ? 2 : 0;
      assert.equal(result.status, code === 'EACCES' ? 1 : normalStatus, result.stderr);
      if (code === 'EACCES') assert.match(result.stderr, /stdout control EACCES/);
    });
  }
  for (const [signal, closedStdout, repeatedSignal] of [
    ['SIGINT', false],
    ['SIGTERM', false],
    ['SIGHUP', false],
    ['SIGHUP', true],
    ['SIGINT', false, true],
    ['SIGTERM', false, true],
    ['SIGHUP', false, true],
  ]) {
    test(`${cli} CLI ${signal}${closedStdout ? ' with closed stdout' : ''}${repeatedSignal ? ' repeated during cleanup' : ''} cleans up after Docker creates a container`, async (t) => {
      const f = fixture(t, {
        editRecord(record) {
          record.schema = 2;
          record.images.web.built = true;
          record.images.builder = {
            ref: 'example.test/haive-test-builder:9.9.9',
            id: `sha256:${'5'.repeat(64)}`,
            built: true,
          };
        },
      });
      const dir = dirname(f.path);
      const bin = join(dir, 'bin');
      const calls = join(dir, 'docker-calls.jsonl');
      const envFiles = join(dir, 'env-files.jsonl');
      const closed = join(dir, 'stdout-closed');
      const outputError = join(dir, 'stdout-error');
      const secondSignal = join(dir, 'second-signal');
      const preload = join(dir, 'closed-stdout.mjs');
      const ready = join(dir, 'worker-ready');
      mkdirSync(bin);
      if (closedStdout)
        writeFileSync(
          preload,
          `import {existsSync,writeFileSync} from 'node:fs';
process.stdout.on('error', error => writeFileSync(${JSON.stringify(outputError)}, error.code));
const timer = setInterval(() => {
  if (existsSync(${JSON.stringify(closed)})) {
    clearInterval(timer);
    process.stdout.write('closed stdout control\\n');
  }
}, 10);
`,
        );
      const fakeDocker = join(bin, 'docker');
      writeFileSync(
        fakeDocker,
        `#!${process.execPath}
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args[0]==='run') {
  for(let i=0;i<args.length;i++) if(args[i]==='--env-file') appendFileSync(${JSON.stringify(envFiles)}, JSON.stringify({path:args[i+1],body:readFileSync(args[i+1],'utf8')})+'\\n');
  if(args[args.indexOf('--name')+1].endsWith('-worker')) {
    if (${closedStdout}) {
      appendFileSync(${JSON.stringify(ready)}, 'ready');
      const deadline = Date.now() + 5000;
      while (!existsSync(${JSON.stringify(outputError)})) {
        if (Date.now() > deadline) throw new Error('stdout did not close');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    process.kill(process.ppid,${JSON.stringify(signal)});
  }
}
if (${Boolean(repeatedSignal)} && args[0]==='rm' && !existsSync(${JSON.stringify(secondSignal)})) {
  appendFileSync(${JSON.stringify(secondSignal)}, 'sent');
  process.kill(process.ppid,${JSON.stringify(signal)});
  await new Promise(resolve => setTimeout(resolve, 30));
}
if(args[0]==='image' && args[1]==='inspect') {
  const images=${JSON.stringify(Object.fromEntries(Object.values(JSON.parse(readFileSync(f.path, 'utf8')).images).map((image) => [image.ref, image.id])))};
  process.stdout.write(images[args.at(-1)] ?? 'sha256:'+'4'.repeat(64));
} else if(args[0]==='inspect') process.stdout.write(JSON.stringify(args.at(-1).endsWith('-migrate')?{Running:false,Status:'exited',ExitCode:0}:{Running:true,Status:'running',ExitCode:0}));
else if(args[0]==='exec') process.stdout.write('PONG');
else if(args[0]==='logs') {
  const lines=readFileSync(${JSON.stringify(envFiles)},'utf8').trim().split('\\n');
  process.stdout.write(lines.map(line=>JSON.parse(line).body).join('\\n'));
}
`,
      );
      chmodSync(fakeDocker, 0o700);
      const child = spawn(
        process.execPath,
        [
          ...(closedStdout ? ['--import', preload] : []),
          new URL(`../${cli}.mjs`, import.meta.url).pathname,
          '--record',
          f.path,
        ],
        {
          timeout: 15_000,
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: tmpdir() },
        },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      const closeOutput = closedStdout
        ? setInterval(() => {
            if (existsSync(ready)) {
              clearInterval(closeOutput);
              child.stdout.destroy();
            }
          }, 10)
        : undefined;
      t.after(() => clearInterval(closeOutput));
      child.stdout.on('close', () => {
        if (closedStdout) writeFileSync(closed, 'closed');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const [status, exitSignal] = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (...result) => resolve(result));
      });
      assert.equal(status, 2, stdout + stderr);
      assert.equal(exitSignal, null);
      if (closedStdout) assert.equal(readFileSync(outputError, 'utf8'), 'EPIPE');
      if (repeatedSignal) assert.equal(readFileSync(secondSignal, 'utf8'), 'sent');
      const history = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
      const started = history
        .filter((args) => args[0] === 'run')
        .map((args) => args[args.indexOf('--name') + 1]);
      const removed = history.filter((args) => args[0] === 'rm').map((args) => args.at(-1));
      assert.equal(started.length, 5);
      assert.deepEqual([...removed].sort(), [...started].sort());
      for (const kind of ['network', 'volume']) {
        assert.deepEqual(
          history
            .filter((args) => args[0] === kind && args[1] === 'rm')
            .map((args) => args.at(-1))
            .sort(),
          history
            .filter((args) => args[0] === kind && args[1] === 'create')
            .map((args) => args.at(-1))
            .sort(),
        );
      }
      for (const { path, body } of readFileSync(envFiles, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse)) {
        assert.ok(!existsSync(path));
        for (const line of body.trim().split('\n')) {
          const [key, ...rest] = line.split('=');
          if (/PASSWORD|ENCRYPTION_KEY|SETUP_TOKEN/.test(key))
            assert.ok(!stdout.includes(rest.join('=')));
        }
      }
    });
  }
}

test('schema 2 validates builder metadata but never boots the builder', async (t) => {
  const f = fixture(t, {
    editRecord: (r) => {
      r.schema = 2;
      r.images.builder = {
        ref: 'example.test/haive-test-builder:9.9.9',
        id: `sha256:${'b'.repeat(64)}`,
        built: true,
      };
    },
  });
  assert.equal(await f.check(), 0, f.logs.join('\n'));
  assert.ok(
    !f.calls.some(
      ({ args }) =>
        args.includes('example.test/haive-test-builder:9.9.9') ||
        args.includes(`sha256:${'b'.repeat(64)}`),
    ),
  );
});

test('every boot-check resource carries the same run label without changing names', async (t) => {
  const f = fixture(t);
  assert.equal(await f.check(), 0);
  const prefix = f.created.networks[0];
  const creations = f.calls.filter(
    ({ args }) =>
      args[0] === 'run' || (['network', 'volume'].includes(args[0]) && args[1] === 'create'),
  );
  assert.equal(creations.length, 8);
  for (const { args } of creations) {
    assert.equal(args[args.indexOf('--label') + 1], `haive.boot-check=${prefix}`);
  }
});

test('abort during a dependency pull removes the image this run may have pulled', async (t) => {
  const f = fixture(t, { pullDependencies: true, abortPull: true });
  assert.equal(await f.check(), 2);
  assert.deepEqual(f.created.images, ['pgvector/pgvector:pg18']);
  assert.deepEqual(f.removed.images, f.created.images);
  assert.equal(f.created.networks.length, 0);
});

test('module-report timeout includes the last fetch failure and its cause', async (t) => {
  const f = fixture(t, { reportFetchError: true });
  assert.equal(await f.check(), 2);
  assert.match(
    f.logs.join('\n'),
    /timed out waiting for .*module report.*fetch failed.*ENOTFOUND api.invalid/,
  );
});

test('command timeout while the daemon creates a container still removes it', async (t) => {
  const f = fixture(t, { timeoutCreateLate: true });
  assert.equal(await f.check(), 2);
  assert.ok(f.removed.containers.some((name) => name.endsWith('-api')));
  assert.match(f.logs.join('\n'), /command timed out/);
});

for (const [limit, size, fails] of [
  [2, 3, true],
  [4, 3, false],
  [4, 5, true],
]) {
  test(`shared child runner keeps the ${limit} MiB cap for ${size} MiB of output`, async () => {
    const { createCapture } = await import('../channel-capture.mjs');
    const result = await createCapture(limit)(
      process.execPath,
      ['-e', `process.stdout.write(Buffer.alloc(${size} * 1024 * 1024, 120))`],
      { timeout: 5000 },
    );
    if (fails) {
      assert.equal(result.error?.message, `command output exceeded ${limit} MiB`);
      assert.ok(Buffer.byteLength(result.stdout) <= limit * 1024 * 1024);
    } else {
      assert.equal(result.status, 0);
      assert.equal(result.error, undefined);
      assert.equal(Buffer.byteLength(result.stdout), size * 1024 * 1024);
    }
  });
}

test('shared child runner bounds combined stdout and stderr', async () => {
  const { createCapture } = await import('../channel-capture.mjs');
  const result = await createCapture(2)(
    process.execPath,
    [
      '-e',
      'process.stdout.write(Buffer.alloc(1536 * 1024)); process.stderr.write(Buffer.alloc(1536 * 1024))',
    ],
    { timeout: 5000 },
  );
  assert.equal(result.error?.message, 'command output exceeded 2 MiB');
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 2 * 1024 * 1024);
});

test('shared child runner preserves timeout, interruption and spawn errors', async () => {
  const { createCapture } = await import('../channel-capture.mjs');
  const capture = createCapture(2);
  const timeout = await capture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeout: 50,
  });
  assert.equal(timeout.error?.code, 'ETIMEDOUT');
  assert.equal(timeout.error?.message, 'command timed out');
  const aborted = await capture(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeout: 5000,
    signal: AbortSignal.abort(),
  });
  assert.equal(aborted.error?.message, 'interrupted');
  const missing = await capture(join(tmpdir(), 'nonexistent-channel-capture-command'), [], {
    timeout: 1000,
  });
  assert.equal(missing.error?.code, 'ENOENT');
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, '');
});

test('a failed dependency pull with no image does not report a cleanup failure', async (t) => {
  const f = fixture(t, { pullDependencies: true, pullFailure: true });
  assert.equal(await f.check(), 2);
  assert.match(f.logs.join('\n'), /pull.*failed.*pull refused/);
  assert.doesNotMatch(f.logs.join('\n'), /cleanup failed|removed image/);
  assert.ok(f.calls.some(({ args }) => args[0] === 'image' && args[1] === 'rm'));
});

test('a module-report response clears an earlier fetch error before a worker timeout', async (t) => {
  const f = fixture(t, { transientReport: true, noWorker: true });
  assert.equal(await f.check(), 2);
  assert.ok(f.requests.filter(({ url }) => url.endsWith('/modules/loaded')).length > 1);
  assert.match(f.logs.join('\n'), /timed out waiting for .*module report/);
  assert.doesNotMatch(f.logs.join('\n'), /last fetch error|connection reset/);
});
