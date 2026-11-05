import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
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
  const logs = [];
  let expectation;
  let scratch;
  let secret;
  const runner = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    assert.ok(!JSON.stringify({ cmd, args, env: options.env }).includes(TOKEN));
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
      writeFileSync(join(tree, '.npmrc'), '@haive-module:registry=https://npm.pkg.github.com\n');
      return ok();
    }
    if (cmd === 'pnpm' || (cmd === process.execPath && args[0].endsWith('/module.mjs'))) {
      secret = options.env.NPM_CONFIG_USERCONFIG;
      assert.equal(statSync(secret).mode & 0o777, 0o600);
      assert.ok(readFileSync(secret, 'utf8').includes(`:_authToken=${TOKEN}`));
      assert.ok(relative(options.cwd, secret).startsWith('..'));
      if (cmd === 'pnpm') {
        return ok(JSON.stringify(config.exports ?? { './manifest': './dist/manifest.js' }));
      }
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
      return { status: config.buildFailure ? 1 : 0, stdout: `build output ${TOKEN}\n` };
    }
    if (cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect') {
      return ok(`sha256:${'a'.repeat(64)}\n`);
    }
    if (cmd === process.execPath && args[0].endsWith('/channel-gate.mjs')) {
      const file = args[args.indexOf('--expect') + 1];
      expectation = JSON.parse(readFileSync(file, 'utf8'));
      parseExpect(JSON.stringify(expectation));
      assert.equal(readFileSync(args[args.indexOf('--token-file') + 1], 'utf8').trim(), TOKEN);
      return {
        status: config.gateCode ?? 0,
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
        env: { PATH: process.env.PATH, UNRELATED_SECRET: TOKEN },
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
  assert.equal(f.calls.length, 1);
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
