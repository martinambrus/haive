import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
      created.images.push(args.at(-1));
      return ok();
    }
    if (args[0] === 'image' && args[1] === 'rm') {
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
        r.schema = 2;
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
  });
}

test('abort before container creation does not report a leftover', async (t) => {
  const f = fixture(t, { abortBeforeCreate: true });
  assert.equal(await f.check(), 2);
  assert.doesNotMatch(f.logs.join('\n'), /leftover/);
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`CLI ${signal} cleans up after Docker creates a container`, (t) => {
    const f = fixture(t);
    const dir = dirname(f.path);
    const bin = join(dir, 'bin');
    const calls = join(dir, 'docker-calls.jsonl');
    const envFiles = join(dir, 'env-files.jsonl');
    mkdirSync(bin);
    const fakeDocker = join(bin, 'docker');
    writeFileSync(
      fakeDocker,
      `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
if(args[0]==='run') {
  for(let i=0;i<args.length;i++) if(args[i]==='--env-file') appendFileSync(${JSON.stringify(envFiles)}, JSON.stringify({path:args[i+1],body:readFileSync(args[i+1],'utf8')})+'\\n');
  if(args[args.indexOf('--name')+1].endsWith('-worker')) process.kill(process.ppid,${JSON.stringify(signal)});
}
if(args[0]==='image' && args[1]==='inspect') {
  const images=${JSON.stringify(Object.fromEntries(Object.entries(IDS).map(([key, id]) => [`example.test/haive-test-${key}:9.9.9`, id])))};
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
    const result = spawnSync(
      process.execPath,
      [new URL('../channel-boot-check.mjs', import.meta.url).pathname, '--record', f.path],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, TMPDIR: tmpdir() },
      },
    );
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.signal, null);
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
          assert.ok(!result.stdout.includes(rest.join('=')));
      }
    }
  });
}
