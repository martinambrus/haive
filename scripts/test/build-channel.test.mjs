import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { run } from '../build-channel.mjs';
import { parseExpect } from '../channel-gate.mjs';

const TOKEN = 't351-secret-that-must-never-be-printed';
const SHA = '1234567890abcdef1234567890abcdef12345678';
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

function seedTree(tree, config = {}) {
  for (const file of ['scripts/module.mjs', 'scripts/gen-modules.mjs']) {
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    if (config.missingTool !== file) writeFileSync(join(tree, file), '');
  }
  for (const host of ['api', 'worker', 'web']) {
    const file = `packages/${host}/Dockerfile`;
    mkdirSync(dirname(join(tree, file)), { recursive: true });
    writeFileSync(
      join(tree, file),
      config.missingTool === file
        ? 'RUN pnpm install'
        : 'RUN --mount=type=secret,id=npmrc,target=/root/.npmrc pnpm install',
    );
  }
  writeFileSync(
    join(tree, '.npmrc'),
    `@haive-module:registry=${config.scope ?? 'https://npm.pkg.github.com'}\n`,
  );
  mkdirSync(join(tree, 'modules'), { recursive: true });
  writeFileSync(join(tree, 'modules', '.gitkeep'), '');
  if (config.local) {
    mkdirSync(join(tree, 'modules', 'statistics'));
    writeFileSync(
      join(tree, 'modules', 'statistics', 'package.json'),
      JSON.stringify({
        name: config.localName ?? '@haive/module-statistics',
        exports: { './web': './dist/web/index.js', './dashboard': './dist/dashboard/index.js' },
      }),
    );
  }
}

function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'haive-channel-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const modules = join(dir, 'modules.json');
  const token = join(dir, 'token');
  const out = join(dir, 'out');
  writeFileSync(modules, JSON.stringify(config.modules ?? []));
  writeFileSync(token, `${TOKEN}\n`);
  const calls = [];
  const violations = [];
  t.after(() => assert.deepEqual(violations, []));
  const logs = [];
  let expectation;
  let scratch;
  let secret;
  const runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (JSON.stringify({ cmd, args, env: options.env }).includes(TOKEN))
      violations.push({ cmd, args, env: options.env });
    config.onCall?.(cmd, args, options);
    if (cmd === 'git' && args.includes('status')) return ok(config.dirtyGate ?? '');
    if (config.delegate && (cmd === 'git' || cmd === 'tar')) {
      return spawnSync(cmd, args, { ...options, encoding: 'utf8' });
    }
    if (cmd === 'git' && args.includes('rev-parse')) {
      return config.missingTag ? { status: 128, stderr: 'unknown tag' } : ok(`${SHA}\n`);
    }
    if (cmd === 'git' && args.includes('archive')) {
      const output = args.find((arg) => arg.startsWith('--output=')).slice('--output='.length);
      scratch = dirname(output);
      writeFileSync(output, 'archive');
      return ok();
    }
    if (cmd === 'tar') {
      const tree = args[args.indexOf('-C') + 1];
      mkdirSync(join(tree, 'scripts'), { recursive: true });
      seedTree(tree, config);
      return ok();
    }
    if (cmd === 'pnpm' || (cmd === process.execPath && args[0].endsWith('/module.mjs'))) {
      secret = options.env.NPM_CONFIG_USERCONFIG;
      assert.equal(statSync(secret).mode & 0o777, 0o600);
      assert.ok(readFileSync(secret, 'utf8').includes(`:_authToken=${TOKEN}`));
      assert.ok(relative(options.cwd, secret).startsWith('..'));
      if (cmd === 'pnpm') {
        return ok(
          config.emptyMetadata
            ? ''
            : JSON.stringify(config.exports ?? { './manifest': './dist/manifest.js' }),
        );
      }
      assert.ok(!readFileSync(join(options.cwd, '.npmrc'), 'utf8').includes(TOKEN));
      return ok(`module added\n${TOKEN}\n`);
    }
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'ls') {
      if (config.dockerFailure) return { status: 1, stderr: 'Cannot connect to Docker daemon' };
      return ok(config.existing ? 'sha256:old\n' : '');
    }
    if (cmd === 'docker' && args[0] === 'buildx') {
      const context = args.at(-1);
      secret = args[args.indexOf('--secret') + 1].split('src=')[1];
      scratch ??= dirname(context);
      assert.ok(relative(context, secret).startsWith('..'));
      assert.equal(statSync(secret).mode & 0o777, 0o600);
      assert.ok(readFileSync(secret, 'utf8').includes(TOKEN));
      assert.ok(!readFileSync(join(context, '.npmrc'), 'utf8').includes(TOKEN));
      if (config.delegate) assert.equal(readFileSync(join(context, 'marker'), 'utf8'), 'tag');
      if (options.onOutput) {
        options.onOutput('build output ' + TOKEN.slice(0, 10), 'stdout');
        options.onOutput('stderr progress\n', 'stderr');
        options.onOutput(TOKEN.slice(10) + '\n', 'stdout');
      }
      return {
        status: config.buildFailure ? 1 : 0,
        stdout: options.onOutput ? '' : `build output ${TOKEN}\n`,
      };
    }
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
      if (args.includes('{{json .RepoDigests}}'))
        return ok(
          JSON.stringify([
            `${args.at(-1).split(':').slice(0, -1).join(':')}@sha256:${'b'.repeat(64)}`,
          ]),
        );
      const afterGate = expectation !== undefined;
      return ok(`sha256:${(config.changedId && afterGate ? 'c' : 'a').repeat(64)}\n`);
    }
    if (cmd === 'docker' && args[0] === 'info')
      return ok(
        JSON.stringify({
          Driver: 'overlayfs',
          DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
        }),
      );
    if (cmd === 'docker' && args[0] === 'pull') return ok('pulled');
    if (cmd === process.execPath && args[0].endsWith('/channel-gate.mjs')) {
      const file = args[args.indexOf('--expect') + 1];
      expectation = JSON.parse(readFileSync(file, 'utf8'));
      parseExpect(JSON.stringify(expectation));
      if (config.cleanupFailure) {
        const locked = join(scratch, 'locked');
        mkdirSync(locked);
        writeFileSync(join(locked, 'file'), 'locked');
        chmodSync(locked, 0);
        t.after(() => {
          chmodSync(locked, 0o700);
          rmSync(scratch, { recursive: true, force: true });
        });
      }
      assert.equal(readFileSync(args[args.indexOf('--token-file') + 1], 'utf8').trim(), TOKEN);
      return {
        status: 'gateCode' in config ? config.gateCode : 0,
        stdout: config.gateCode ? `OFFENDER api token ${TOKEN}\n` : '',
      };
    }
    throw new Error(`unexpected command ${cmd} ${JSON.stringify(args)}`);
  };
  const argv = [
    '--tag',
    'v1.2.3',
    '--channel',
    'acme',
    '--modules',
    modules,
    '--token-file',
    token,
    '--out',
    out,
  ];
  return {
    root,
    out,
    calls,
    logs,
    argv,
    dir,
    get expectation() {
      return expectation;
    },
    get scratch() {
      return scratch;
    },
    get secret() {
      return secret;
    },
    execute(extra = []) {
      return run([...argv, ...extra], {
        root,
        runner,
        env: { PATH: process.env.PATH, UNRELATED_SECRET: TOKEN, ...config.env },
        signal: config.signal,
        say: (line) => logs.push(line),
      });
    },
  };
}

for (const tag of ['v1.2.3-rc.1', 'v1.2.3+meta', '1.2.3', 'v01.2.3']) {
  test(`refuses non-final tag ${tag} before spawning`, async (t) => {
    const f = fixture(t);
    f.argv[1] = tag;
    assert.equal(await f.execute(), 2);
    assert.equal(f.calls.length, 0);
  });
}

test('refuses a missing tag without archiving or building', async (t) => {
  const f = fixture(t, { missingTag: true });
  assert.equal(await f.execute(), 2);
  assert.ok(!f.calls.some((c) => c.cmd !== 'git'));
});

for (const channel of ['ACME', '../acme', '-acme', 'acme-', 'a'.repeat(33), '']) {
  test(`refuses bad channel ${JSON.stringify(channel)}`, async (t) => {
    const f = fixture(t);
    f.argv[3] = channel;
    assert.equal(await f.execute(), 2);
    assert.equal(f.calls.length, 0);
  });
}

for (const spec of [
  '@haive-module/demo@^1.0.0',
  '@haive-module/demo@latest',
  '@haive-module/demo',
  '@haive-module/demo@1.2',
  '@haive-module/demo@01.2.3',
  '@haive-module/demo@1.2.3-01',
  '@haive-module/UPPER@1.2.3',
  '@haive/module-demo@1.2.3',
  `@haive-module/${'a'.repeat(24)}@1.2.3`,
]) {
  test(`refuses invalid entitlement ${spec}`, async (t) => {
    const f = fixture(t, { modules: [spec] });
    assert.equal(await f.execute(), 2);
    assert.equal(f.calls.length, 0);
  });
}

test('refuses duplicate module ids and malformed input', async (t) => {
  for (const modules of [['@haive-module/demo@1.0.0', '@haive-module/demo@2.0.0'], {}, [null]]) {
    const f = fixture(t, { modules });
    assert.equal(await f.execute(), 2);
    assert.equal(f.calls.length, 0);
  }
});

test('archives the resolved tag, adds each entitlement once and round-trips the gate expectation', async (t) => {
  const f = fixture(t, {
    modules: ['@haive-module/alpha@1.2.3', '@haive-module/beta@2.0.0-rc.1+build'],
  });
  assert.equal(await f.execute(), 0);
  const resolve = f.calls.find((c) => c.cmd === 'git' && c.args.includes('rev-parse'));
  assert.ok(resolve.args.includes('refs/tags/v1.2.3^{commit}'));
  const archive = f.calls.find((c) => c.cmd === 'git' && c.args.includes('archive'));
  assert.ok(archive.args.includes(SHA));
  assert.ok(!archive.args.includes('HEAD'));
  const adds = f.calls.filter(
    (c) => c.cmd === process.execPath && c.args[0].endsWith('/module.mjs'),
  );
  assert.deepEqual(
    adds.map((c) => c.args.slice(1)),
    [
      ['add', '@haive-module/alpha@1.2.3'],
      ['add', '@haive-module/beta@2.0.0-rc.1+build'],
    ],
  );
  assert.ok(adds.every((c) => c.options.cwd !== f.root));
  assert.deepEqual(f.expectation, {
    version: '1.2.3',
    images: {
      api: 'ghcr.io/martinambrus/haive-acme-api:1.2.3',
      worker: 'ghcr.io/martinambrus/haive-acme-worker:1.2.3',
      web: 'ghcr.io/martinambrus/haive-web:1.2.3',
    },
    modules: [
      { packageName: '@haive-module/alpha', source: 'registry', version: '1.2.3', webParts: [] },
      {
        packageName: '@haive-module/beta',
        source: 'registry',
        version: '2.0.0-rc.1+build',
        webParts: [],
      },
    ],
  });
});

test('empty entitlement builds api and worker, uses secrets and stamps, and writes a versioned record', async (t) => {
  const f = fixture(t);
  assert.equal(await f.execute(['--registry', 'registry.example:5000/vendor']), 0);
  const builds = f.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'buildx');
  assert.equal(builds.length, 2);
  for (const { args } of builds) {
    assert.ok(args.includes('--load'));
    assert.ok(args.includes('--secret'));
    assert.ok(args.includes('HAIVE_VERSION=1.2.3'));
    assert.ok(args.includes('--platform'));
    assert.ok(!args.some((arg) => /push|login/.test(arg)));
  }
  assert.equal(f.expectation.images.web, 'ghcr.io/martinambrus/haive-web:1.2.3');
  const record = JSON.parse(readFileSync(join(f.out, 'build-record.json'), 'utf8'));
  assert.equal(record.schema, 1);
  assert.equal(record.tag, 'v1.2.3');
  assert.equal(record.channel, 'acme');
  assert.deepEqual(record.modules, []);
  assert.deepEqual(Object.keys(record.images).sort(), ['api', 'web', 'worker']);
  for (const image of Object.values(record.images)) {
    assert.match(image.ref, /:1\.2\.3$/);
    assert.match(image.id, /^sha256:[a-f0-9]{64}$/);
  }
  assert.ok(!existsSync(f.secret));
  assert.ok(!existsSync(f.scratch));
  assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
});

for (const parts of [['./web'], ['./dashboard'], ['./web', './dashboard']]) {
  test(`builds web when exported: ${parts.join(', ')}`, async (t) => {
    const f = fixture(t, {
      modules: ['@haive-module/demo@1.0.0'],
      exports: Object.fromEntries(['./manifest', ...parts].map((p) => [p, './dist/part.js'])),
    });
    assert.equal(await f.execute(), 0);
    assert.equal(f.calls.filter((c) => c.cmd === 'docker' && c.args[0] === 'buildx').length, 3);
    assert.equal(f.expectation.images.web, 'ghcr.io/martinambrus/haive-acme-web:1.2.3');
    assert.deepEqual(f.expectation.modules[0].webParts, parts.map((p) => p.slice(2)).sort());
  });
}

test('rejects registry metadata with no manifest before building', async (t) => {
  const f = fixture(t, { modules: ['@haive-module/demo@1.0.0'], exports: {} });
  assert.equal(await f.execute(), 2);
  assert.ok(!f.calls.some((c) => c.args[0] === 'buildx'));
  assert.ok(!existsSync(f.scratch));
});

test('failed build redacts output, cleans secrets and tree and writes no record', async (t) => {
  const f = fixture(t, { buildFailure: true });
  assert.equal(await f.execute(), 2);
  assert.ok(!existsSync(f.secret));
  assert.ok(!existsSync(f.scratch));
  assert.ok(!existsSync(join(f.out, 'build-record.json')));
  assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
  assert.ok(!f.calls.some((c) => c.args[0]?.endsWith('/channel-gate.mjs')));
});

for (const gateCode of [1, 2]) {
  test(`propagates gate exit ${gateCode} and OFFENDER lines without a success record`, async (t) => {
    const f = fixture(t, { gateCode });
    assert.equal(await f.execute(), gateCode);
    assert.ok(f.logs.some((line) => line.includes('OFFENDER api')));
    assert.ok(!JSON.stringify(f.logs).includes(TOKEN));
    assert.ok(!existsSync(join(f.out, 'build-record.json')));
    assert.ok(!existsSync(f.secret));
    assert.ok(!existsSync(f.scratch));
  });
}

test('refuses existing local output tags unless --replace is given', async (t) => {
  const f = fixture(t, { existing: true });
  assert.equal(await f.execute(), 2);
  assert.ok(!f.calls.some((c) => c.args[0] === 'buildx'));
  assert.equal(await f.execute(['--replace']), 0);
});

test('a failed Docker query cannot be mistaken for an absent local tag', async (t) => {
  const f = fixture(t, { dockerFailure: true });
  assert.equal(await f.execute(), 2);
  assert.ok(!f.calls.some((c) => c.args[0] === 'buildx'));
});

test('real git archive contains tag contents despite different HEAD and dirty files', async (t) => {
  const f = fixture(t, { delegate: true });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Channel Test');
  git('config', 'user.email', 'channel@example.invalid');
  seedTree(f.root);
  writeFileSync(join(f.root, 'marker'), 'tag');
  writeFileSync(join(f.root, '.npmrc'), '@haive-module:registry=https://npm.pkg.github.com\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'tag tree');
  git('tag', 'v1.2.3');
  writeFileSync(join(f.root, 'marker'), 'HEAD');
  git('commit', '--quiet', '-am', 'new HEAD');
  writeFileSync(join(f.root, 'marker'), 'dirty checkout');
  assert.equal(await f.execute(), 0);
  assert.equal(readFileSync(join(f.root, 'marker'), 'utf8'), 'dirty checkout');
});

for (const scope of [
  'http://npm.example.com',
  'https://user:pass@npm.example.com',
  'https://npm.example.com/?token=bad',
]) {
  test(`refuses unsafe module registry ${scope} before any network use`, async (t) => {
    const f = fixture(t, { scope, modules: ['@haive-module/demo@1.0.0'] });
    assert.equal(await f.execute(), 2);
    assert.ok(f.logs.some((line) => line.includes('HTTPS URL without credentials')));
    assert.ok(!f.calls.some((c) => c.cmd === 'pnpm' || c.cmd === 'docker'));
    assert.ok(!existsSync(f.scratch));
  });
}

test('stock web is pulled for the build platform before the gate, even with an existing stock tag', async (t) => {
  const f = fixture(t);
  assert.equal(await f.execute(['--source-registry', 'localhost:5000/public']), 0);
  const pull = f.calls.find((c) => c.cmd === 'docker' && c.args[0] === 'pull');
  assert.deepEqual(pull.args, [
    'pull',
    '--platform',
    `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`,
    'localhost:5000/public/haive-web:1.2.3',
  ]);
  assert.ok(f.logs.some((line) => line.includes('pulling stock web')));
  assert.ok(
    !f.calls.some(
      (c) => c.args[0] === 'image' && c.args[1] === 'ls' && c.args.at(-1).includes('/haive-web:'),
    ),
  );
  assert.ok(f.calls.indexOf(pull) > f.calls.findLastIndex((c) => c.args[0] === 'buildx'));
  assert.ok(
    f.calls.indexOf(pull) < f.calls.findIndex((c) => c.args[0]?.endsWith('/channel-gate.mjs')),
  );
});

test('rebuilt web skips the stock pull and includes local web parts', async (t) => {
  const f = fixture(t, {
    local: true,
    modules: ['@haive-module/demo@1.0.0'],
    exports: { './manifest': './dist/manifest.js', './web': './dist/web.js' },
  });
  assert.equal(await f.execute(), 0);
  assert.ok(!f.calls.some((c) => c.args[0] === 'pull'));
  assert.deepEqual(
    f.expectation.modules.find((m) => m.source === 'local'),
    { packageName: '@haive/module-statistics', source: 'local', webParts: ['dashboard', 'web'] },
  );
});

test('stock web expects local statistics dashboard and web parts without forcing a rebuild', async (t) => {
  const f = fixture(t, { local: true });
  assert.equal(await f.execute(), 0);
  assert.equal(f.calls.filter((c) => c.args[0] === 'buildx').length, 2);
  assert.deepEqual(f.expectation.modules, [
    { packageName: '@haive/module-statistics', source: 'local', webParts: ['dashboard', 'web'] },
  ]);
});

test('invalid local package id and local/registry collision fail before builds', async (t) => {
  for (const config of [{ localName: 'bad' }, { modules: ['@haive-module/statistics@1.0.0'] }]) {
    const f = fixture(t, { local: true, ...config });
    assert.equal(await f.execute(), 2);
    assert.ok(!f.calls.some((c) => c.args[0] === 'buildx'));
  }
});

for (const missingTool of [
  'scripts/module.mjs',
  'scripts/gen-modules.mjs',
  'packages/api/Dockerfile',
  'packages/worker/Dockerfile',
  'packages/web/Dockerfile',
]) {
  for (const modules of [[], ['@haive-module/demo@1.0.0']]) {
    test(`preflight names ${missingTool}, modules=${modules.length}, before network`, async (t) => {
      const f = fixture(t, { missingTool, modules });
      assert.equal(await f.execute(), 2);
      assert.ok(f.logs.some((line) => line.includes('preflight') && line.includes(missingTool)));
      assert.ok(!f.calls.some((c) => c.cmd === 'pnpm' || c.cmd === 'docker'));
      assert.ok(!existsSync(f.scratch));
    });
  }
}

test('record pins platform, image store, built markers and pulled digest', async (t) => {
  const f = fixture(t);
  assert.equal(await f.execute(), 0);
  const record = JSON.parse(readFileSync(join(f.out, 'build-record.json'), 'utf8'));
  assert.equal(record.platform, `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`);
  assert.deepEqual(record.imageStore, {
    Driver: 'overlayfs',
    DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
  });
  assert.equal(record.images.api.built, true);
  assert.equal(record.images.worker.built, true);
  assert.equal(record.images.web.built, false);
  assert.equal(
    record.images.web.repoDigest,
    `ghcr.io/martinambrus/haive-web@sha256:${'b'.repeat(64)}`,
  );
  const gateIndex = f.calls.findIndex((c) => c.args[0]?.endsWith('/channel-gate.mjs'));
  for (const ref of Object.values(f.expectation.images)) {
    const inspections = f.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.args.includes('{{.Id}}') && c.args.at(-1) === ref);
    assert.ok(inspections.some(({ i }) => i < gateIndex));
    assert.ok(inspections.some(({ i }) => i > gateIndex));
  }
});

test('deletes stale record before building and retains named tags on gate failure', async (t) => {
  let f;
  f = fixture(t, {
    gateCode: 1,
    onCall(cmd, args) {
      if (args[0] === 'buildx') assert.ok(!existsSync(join(f.out, 'build-record.json')));
    },
  });
  mkdirSync(f.out);
  writeFileSync(join(f.out, 'build-record.json'), 'stale');
  assert.equal(await f.execute(), 1);
  assert.ok(!existsSync(join(f.out, 'build-record.json')));
  assert.ok(
    f.logs.some((line) => line.includes('retained') && line.includes('haive-acme-api:1.2.3')),
  );
});

test('refuses image identity changes across the gate', async (t) => {
  const f = fixture(t, { changedId: true });
  assert.equal(await f.execute(), 2);
  assert.ok(f.logs.some((line) => line.includes('changed')));
  assert.ok(!existsSync(join(f.out, 'build-record.json')));
});

for (const flag of ['registry', 'source-registry']) {
  for (const prefix of [
    'https://example.com/repo',
    'UPPER/repo',
    'example.com/repo:tag',
    '../repo',
    '',
  ]) {
    test(`refuses invalid --${flag} ${JSON.stringify(prefix)}`, async (t) => {
      const f = fixture(t);
      assert.equal(await f.execute([`--${flag}`, prefix]), 2);
      assert.ok(f.logs.some((line) => line.includes(`${flag} must be`)));
      assert.equal(f.calls.length, 0);
    });
  }
}

test('output and source prefixes are independent, source defaults to HAIVE_REGISTRY', async (t) => {
  const f = fixture(t, { env: { HAIVE_REGISTRY: 'source.example/vendor' } });
  assert.equal(await f.execute(['--registry', 'output.example/customer']), 0);
  assert.equal(f.expectation.images.api, 'output.example/customer/haive-acme-api:1.2.3');
  assert.equal(f.expectation.images.web, 'source.example/vendor/haive-web:1.2.3');
});

for (const flag of [
  'tag',
  'channel',
  'modules',
  'token-file',
  'registry',
  'source-registry',
  'out',
]) {
  test(`refuses repeated --${flag}`, async (t) => {
    const f = fixture(t);
    const extra = [`--${flag}`, 'x'];
    if (!f.argv.includes(`--${flag}`)) extra.push(`--${flag}`, 'y');
    assert.equal(await f.execute(extra), 2);
    assert.ok(f.logs.some((line) => line.includes(`--${flag}`)));
    assert.equal(f.calls.length, 0);
  });
  test(`refuses missing --${flag} value`, async (t) => {
    const f = fixture(t);
    assert.equal(await f.execute([`--${flag}`]), 2);
    assert.equal(f.calls.length, 0);
  });
}

for (const flag of ['tag', 'channel', 'modules', 'token-file']) {
  test(`refuses absent required --${flag}`, async (t) => {
    const f = fixture(t);
    const index = f.argv.indexOf(`--${flag}`);
    f.argv.splice(index, 2);
    assert.equal(await f.execute(), 2);
    assert.ok(f.logs.some((line) => line.includes(`--${flag}`)));
    assert.equal(f.calls.length, 0);
  });
}

test('refuses a temporary directory inside the repository', async (t) => {
  const f = fixture(t);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = f.root;
  try {
    assert.equal(await f.execute(), 2);
    assert.ok(f.logs.some((line) => line.includes('temporary directory must be outside')));
    assert.ok(!f.calls.some((c) => c.args.includes('archive')));
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});

for (const gateCode of [3, null, -1]) {
  test(`refuses unexpected gate status ${gateCode}`, async (t) => {
    const f = fixture(t, { gateCode });
    assert.equal(await f.execute(), 2);
    assert.ok(f.logs.some((line) => line.includes('channel gate could not finish')));
    assert.ok(!existsSync(join(f.out, 'build-record.json')));
  });
}

test('abort during build removes scratch and secrets without gate or record', async (t) => {
  const controller = new AbortController();
  let observedSignal;
  const f = fixture(t, {
    signal: controller.signal,
    onCall(cmd, args, options) {
      if (args[0] === 'buildx') {
        observedSignal = options.signal;
        controller.abort();
      }
    },
  });
  assert.equal(await f.execute(), 2);
  assert.equal(observedSignal, controller.signal);
  assert.ok(!existsSync(f.scratch));
  assert.ok(!existsSync(f.secret));
  assert.ok(!f.calls.some((c) => c.args[0]?.endsWith('/channel-gate.mjs')));
});

test('build commands pin tags, Dockerfiles, context, production target, and ordering', async (t) => {
  const f = fixture(t, { modules: ['@haive-module/demo@1.0.0'] });
  assert.equal(await f.execute(), 0);
  const builds = f.calls.filter((c) => c.args[0] === 'buildx');
  for (const [i, host] of ['api', 'worker'].entries()) {
    const { args, options } = builds[i];
    const tree = args.at(-1);
    assert.equal(args[args.indexOf('--tag') + 1], f.expectation.images[host]);
    assert.equal(args[args.indexOf('--file') + 1], join(tree, 'packages', host, 'Dockerfile'));
    assert.equal(options.cwd, tree);
    assert.equal(args[args.indexOf('--target') + 1], 'production');
    assert.equal(typeof options.onOutput, 'function');
    assert.ok(
      f.calls.findIndex((c) => c.args[0]?.endsWith('/module.mjs')) < f.calls.indexOf(builds[i]),
    );
  }
});

test('existing output tag is refused before registry metadata or module add', async (t) => {
  const f = fixture(t, { existing: true, modules: ['@haive-module/demo@1.0.0'] });
  assert.equal(await f.execute(), 2);
  assert.ok(!f.calls.some((c) => c.cmd === 'pnpm' || c.args[0]?.endsWith('/module.mjs')));
});

test('out is probed for writability before builds', async (t) => {
  const f = fixture(t);
  mkdirSync(f.out);
  chmodSync(f.out, 0o500);
  try {
    assert.equal(await f.execute(), 2);
    assert.ok(!f.calls.some((c) => c.args[0] === 'buildx'));
  } finally {
    chmodSync(f.out, 0o700);
  }
});

for (const dirtyGate of [
  ' M scripts/channel-gate.mjs\n',
  'M  scripts/smoke/scan-image.sh\n',
  '?? scripts/channel-gate.mjs\n',
]) {
  test(`refuses dirty gate ${dirtyGate.trim()}`, async (t) => {
    const f = fixture(t, { dirtyGate });
    assert.equal(await f.execute(), 2);
    assert.ok(f.logs.some((line) => line.includes('gate tooling is dirty')));
    assert.ok(!f.calls.some((c) => c.cmd === 'pnpm' || c.cmd === 'docker'));
  });
}

test('empty pnpm metadata has a named refusal and isolated cache', async (t) => {
  const f = fixture(t, { modules: ['@haive-module/demo@1.0.0'], emptyMetadata: true });
  assert.equal(await f.execute(), 2);
  assert.ok(
    f.logs.some(
      (line) =>
        line.includes('pnpm view returned no exports') && line.includes('@haive-module/demo@1.0.0'),
    ),
  );
  const query = f.calls.find((c) => c.cmd === 'pnpm');
  assert.equal(query.options.env.XDG_CACHE_HOME, join(f.scratch, 'cache'));
});

test('split tokens are scrubbed while build output streams', async (t) => {
  const f = fixture(t);
  assert.equal(await f.execute(), 0);
  assert.ok(f.logs.some((line) => line.includes('build output')));
  assert.ok(f.logs.some((line) => line.includes('[token]')));
  assert.ok(!f.logs.join('').includes(TOKEN));
  assert.ok(!f.logs.some((line) => line.includes(TOKEN.slice(0, 10))));
});

test('cleanup failure preserves gate status and reports the leftover path', async (t) => {
  const f = fixture(t, { cleanupFailure: true, gateCode: 1 });
  assert.equal(await f.execute(), 1);
  assert.ok(
    f.logs.some(
      (line) => line.includes('cleanup failed; leftover path') && line.includes(f.scratch),
    ),
  );
});

test('default runner streams builds beyond 32 MiB and scrubs split tokens', async (t) => {
  const f = fixture(t);
  seedTree(f.root);
  writeFileSync(join(f.root, 'scripts', 'channel-gate.mjs'), 'process.exitCode = 0;');
  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.name', 'Channel Test'],
    ['config', 'user.email', 'channel@example.invalid'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'tag tree'],
    ['tag', 'v1.2.3'],
  ]) {
    const r = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const bin = join(f.dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'buildx') {
  const chunk = Buffer.alloc(64 * 1024, 'x');
  for (let i = 0; i < 34 * 16; i++) await new Promise(resolve => process.stdout.write(chunk, resolve));
  process.stdout.write(${JSON.stringify(TOKEN.slice(0, 10))});
  await new Promise(resolve => setTimeout(resolve, 20));
  process.stdout.write(${JSON.stringify(TOKEN.slice(10))});
} else if (args[0] === 'info') {
  process.stdout.write(JSON.stringify({ Driver: 'overlayfs', DriverStatus: [] }));
} else if (args[1] === 'inspect') {
  process.stdout.write(args.includes('{{.Id}}') ? 'sha256:${'a'.repeat(64)}' : JSON.stringify(['ghcr.io/martinambrus/haive-web@sha256:${'b'.repeat(64)}']));
}
`,
    { mode: 0o700 },
  );
  let bytes = 0;
  let scrubbed = false;
  const code = await run(f.argv, {
    root: f.root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    say(line) {
      bytes += line.length;
      scrubbed ||= line.includes('[token]');
      assert.ok(!line.includes(TOKEN));
    },
  });
  assert.equal(code, 0);
  assert.ok(bytes > 68 * 1024 * 1024);
  assert.ok(scrubbed);
  assert.ok(existsSync(join(f.out, 'build-record.json')));
});
