import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parseReleaseManifest } from '../../packages/shared/src/release/manifest.ts';
import { run } from '../publish-channel.mjs';

const KEYS = ['api', 'worker', 'web'];
const PREFIX = '127.0.0.1:5050/vendor';
const IDS = Object.fromEntries(KEYS.map((host, i) => [host, `sha256:${String(i + 1).repeat(64)}`]));
const bodies = Object.fromEntries(
  KEYS.map((host) => [
    host,
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { digest: IDS[host] },
      layers: [{ digest: `sha256:${'a'.repeat(64)}` }],
    }),
  ]),
);
const digests = Object.fromEntries(
  KEYS.map((host) => [host, `sha256:${createHash('sha256').update(bodies[host]).digest('hex')}`]),
);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

function fixture(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 't352-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packages/database/migrations'), { recursive: true });
  writeFileSync(
    join(root, 'scripts/build-release-manifest.mjs'),
    readFileSync(new URL('../build-release-manifest.mjs', import.meta.url)),
  );
  writeFileSync(join(root, 'packages/database/migrations/0000_baseline.sql'), 'CREATE TABLE x();');
  writeFileSync(
    join(root, 'packages/database/migrations/0001_record.sql'),
    config.contractingSnapshot ? 'DROP TABLE x;' : 'ALTER TABLE x ADD y int;',
  );
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=T352', '-c', 'user.email=t352@example.test', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'packages/database/migrations/9999_wrong_tree.sql'), 'DROP TABLE x;');
  const record = {
    schema: 1,
    tag: 'v9.9.9',
    version: '9.9.9',
    channel: 'customer',
    commit,
    platform: 'linux/amd64',
    imageStore: { Driver: 'overlayfs' },
    images: Object.fromEntries(
      KEYS.map((host) => [
        host,
        {
          ref: `${PREFIX}/haive-${host === 'web' ? '' : 'customer-'}${host}:9.9.9`,
          id: IDS[host],
          built: host !== 'web',
          ...(host === 'web' ? { repoDigest: `${PREFIX}/haive-web@${IDS.web}` } : {}),
        },
      ]),
    ),
    modules: [],
  };
  config.editRecord?.(record);
  const path = join(dir, 'build-record.json');
  writeFileSync(path, config.raw ?? JSON.stringify(record));
  const out = join(dir, 'out');
  const manifest = join(out, 'release.json');
  const calls = [];
  const requests = [];
  const logs = [];
  const published = new Set();
  const attempted = [];
  const bootCalls = [];
  const inspections = new Map();
  let archiveHost;
  let idReads = 0;
  const runner = async (cmd, args, options) => {
    calls.push({ cmd, args });
    assert.ok(options.timeout > 0);
    assert.ok(!existsSync(manifest), 'manifest is absent until all commands finish');
    if (config.abortOn?.(cmd, args)) options.signal?.throwIfAborted();
    if (cmd === 'docker') {
      if (args[0] === 'image' && args[1] === 'inspect') {
        const host = KEYS.find((key) => record.images[key].ref === args.at(-1));
        idReads++;
        return ok(
          config.mismatch === host || (config.retagAfterBoot && idReads > 3)
            ? `sha256:${'f'.repeat(64)}`
            : IDS[host],
        );
      }
      if (args[0] === 'image' && args[1] === 'save') {
        archiveHost = KEYS.find((host) => IDS[host] === args.at(-1));
        assert.equal(args[args.indexOf('--platform') + 1], record.platform);
        return config.saveFailure ? { status: 1 } : ok();
      }
      if (args[0] === 'image' && args[1] === 'tag') return ok();
      if (args[0] === 'buildx' && args[2] === 'inspect') {
        const ref = args.at(-1);
        if (args.includes('--raw')) {
          assert.equal(ref, record.images.web.repoDigest);
          return ok(
            JSON.stringify({
              manifests: [
                { digest: digests.web, platform: { os: 'linux', architecture: 'amd64' } },
              ],
            }),
          );
        }
        const host = KEYS.find((key) => ref.includes(`customer-${key}:`));
        inspections.set(host, (inspections.get(host) ?? 0) + 1);
        if (config.inspectCaptureError) return { status: 1, error: new Error('transport failed') };
        if (
          config.existing === host ||
          published.has(host) ||
          (config.appeared === host && inspections.get(host) > 1)
        ) {
          return ok(
            JSON.stringify({ digest: config.rereadMismatch === host ? IDS.api : digests[host] }),
          );
        }
        if (config.rereadFailure === host && attempted.includes(host)) return { status: 1 };
        return { status: 1, stderr: config.inspectError ?? 'manifest unknown' };
      }
      const push = args[0] === 'push';
      const copy = args[0] === 'buildx' && args[2] === 'create';
      if (push || copy) {
        const ref = copy ? args[args.indexOf('--tag') + 1] : args.at(-1);
        const host = KEYS.find((key) => ref.includes(`customer-${key}:`));
        attempted.push(host);
        if (config.pushFailure === host) return { status: 1, stderr: 'push failed' };
        if (copy) {
          assert.ok(args.includes('--prefer-index=false'));
          assert.equal(args.at(-1), `${PREFIX}/haive-web@${digests.web}`);
        } else assert.equal(args[args.indexOf('--platform') + 1], record.platform);
        if (config.rereadFailure !== host) published.add(host);
        return ok();
      }
      assert.fail(`unexpected docker command: ${args.join(' ')}`);
    }
    if (cmd === 'tar' && args.includes('-xOf')) {
      if (args.at(-1) === 'index.json') {
        return ok(
          JSON.stringify({
            manifests: [
              { digest: digests[archiveHost], platform: { os: 'linux', architecture: 'amd64' } },
              ...(config.platformArtifacts && archiveHost === 'web'
                ? [
                    {
                      digest: IDS.web,
                      artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
                    },
                  ]
                : []),
            ],
          }),
        );
      }
      return ok(config.corruptManifest ? '{}' : bodies[archiveHost]);
    }
    return spawnSync(cmd, args, { ...options, encoding: 'utf8' });
  };
  const request = async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.ok(!options.headers?.Authorization);
    if (config.fetchError) throw new Error('registry unreachable');
    return {
      status: config.httpStatus ?? 404,
      json: async () => config.httpBody ?? { errors: [{ code: 'MANIFEST_UNKNOWN' }] },
    };
  };
  const bootCheck = async (args, options) => {
    bootCalls.push({ args, options });
    assert.equal(options.runner, runner);
    assert.equal(options.request, request);
    assert.equal(JSON.parse(readFileSync(args[1], 'utf8')).commit, commit);
    return config.bootStatus ?? 0;
  };
  return {
    path,
    root,
    out,
    manifest,
    record,
    calls,
    requests,
    logs,
    attempted,
    bootCalls,
    invoke: (extra = [], options = {}) =>
      run(['--record', path, '--out', out, ...extra], {
        root,
        runner,
        request,
        bootCheck,
        say: (line) => logs.push(line),
        ...options,
      }),
  };
}

test('bad and missing records return 2', async (t) => {
  for (const config of [{ raw: '{' }, { editRecord: (r) => delete r.images.web }]) {
    const f = fixture(t, config);
    assert.equal(await f.invoke(), 2);
    assert.deepEqual(f.attempted, []);
  }
  assert.equal(await run([], { say: () => {} }), 2);
  assert.equal(
    await run(['--record', join(tmpdir(), 't352-does-not-exist')], { say: () => {} }),
    2,
  );
});

for (const host of KEYS) {
  test(`${host} id mismatch returns 2 without booting or pushing`, async (t) => {
    const f = fixture(t, { mismatch: host });
    assert.equal(await f.invoke(), 2);
    assert.deepEqual(f.attempted, []);
    assert.equal(f.bootCalls.length, 0);
  });
}

for (const code of [1, 2]) {
  test(`boot gate exit ${code} is returned without pushing`, async (t) => {
    const f = fixture(t, { bootStatus: code });
    assert.equal(await f.invoke(), code);
    assert.deepEqual(f.attempted, []);
    assert.equal(f.requests.length, 0);
  });
}

test('existing destination refuses with 1 and names the exact remote tag', async (t) => {
  const f = fixture(t, { existing: 'web' });
  assert.equal(await f.invoke(), 1);
  assert.deepEqual(f.attempted, []);
  assert.match(f.logs.join('\n'), /127\.0\.0\.1:5050\/vendor\/haive-customer-web:9\.9\.9/);
});

for (const config of [
  { httpStatus: 500 },
  { httpStatus: 401 },
  { httpBody: { errors: [{ code: 'DENIED' }] } },
  { fetchError: true },
  { inspectCaptureError: true },
  { inspectError: 'credential helper failed' },
  { inspectError: 'connection refused' },
]) {
  test(`registry error ${JSON.stringify(config)} fails closed with 2`, async (t) => {
    const f = fixture(t, config);
    assert.equal(await f.invoke(), 2);
    assert.deepEqual(f.attempted, []);
  });
}

test('publish orders api, worker, web copy, then writes a valid manifest from the recorded tree', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke(), 0, f.logs.join('\n'));
  assert.deepEqual(f.attempted, KEYS);
  const manifest = parseReleaseManifest(JSON.parse(readFileSync(f.manifest, 'utf8')));
  assert.deepEqual(
    manifest.images,
    Object.fromEntries(
      KEYS.map((host) => [host, `${PREFIX}/haive-customer-${host}@${digests[host]}`]),
    ),
  );
  assert.equal(manifest.channel, 'customer');
  assert.equal(manifest.version, '9.9.9');
  assert.equal(manifest.migrationHead, '0001_record');
  assert.equal(manifest.contracts, false);
  assert.ok(
    f.logs.findIndex((s) => s.includes('plan')) < f.logs.findIndex((s) => s.includes('published')),
  );
});

for (const kind of ['pushFailure', 'rereadFailure', 'rereadMismatch']) {
  for (const host of KEYS) {
    test(`${kind} at ${host} returns 2 and leaves no manifest`, async (t) => {
      const f = fixture(t, { [kind]: host });
      assert.equal(await f.invoke(), 2);
      assert.equal(existsSync(f.manifest), false);
      assert.deepEqual(f.attempted, KEYS.slice(0, KEYS.indexOf(host) + 1));
      assert.match(f.logs.join('\n'), /no manifest/i);
    });
  }
}

test('dry-run does all gates, prints a plan, pushes nothing and writes no manifest', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke(['--dry-run']), 0, f.logs.join('\n'));
  assert.equal(f.bootCalls.length, 1);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.attempted, []);
  assert.equal(existsSync(f.manifest), false);
  assert.match(f.logs.join('\n'), /plan.*api/);
});

test('registry override changes destination repositories', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke(['--registry', '127.0.0.1:5051/other']), 0, f.logs.join('\n'));
  const manifest = parseReleaseManifest(JSON.parse(readFileSync(f.manifest, 'utf8')));
  assert.equal(manifest.images.api, `127.0.0.1:5051/other/haive-customer-api@${digests.api}`);
});

test('no argv carries a credential or calls docker login or a credential helper', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke(), 0, f.logs.join('\n'));
  for (const { cmd, args } of f.calls) {
    assert.ok(!cmd.includes('credential'));
    assert.ok(!args.some((arg) => /credential|password|token|login/i.test(arg)));
  }
  assert.equal(await f.invoke(['--token', 'forbidden']), 2);
});

test('retagging after boot is refused before push', async (t) => {
  const f = fixture(t, { retagAfterBoot: true });
  assert.equal(await f.invoke(), 2);
  assert.deepEqual(f.attempted, []);
});

for (const config of [
  { corruptManifest: true },
  { saveFailure: true },
  { editRecord: (r) => delete r.images.web.repoDigest },
]) {
  test(`cannot derive gated platform content: ${JSON.stringify(config)}`, async (t) => {
    const f = fixture(t, config);
    assert.equal(await f.invoke(), 2);
    assert.deepEqual(f.attempted, []);
  });
}

test('a rebuilt web is pushed as a platform manifest', async (t) => {
  const f = fixture(t, {
    editRecord: (r) => {
      r.images.web.built = true;
      delete r.images.web.repoDigest;
    },
  });
  assert.equal(await f.invoke(), 0, f.logs.join('\n'));
  assert.equal(f.calls.filter(({ args }) => args[0] === 'push').length, 3);
  assert.equal(f.calls.filter(({ args }) => args.includes('create')).length, 0);
});

test('a pulled OCI 1.1 web archive may also hold a subject attestation', async (t) => {
  const f = fixture(t, { platformArtifacts: true });
  assert.equal(await f.invoke(), 0, f.logs.join('\n'));
  assert.equal(
    JSON.parse(readFileSync(f.manifest, 'utf8')).images.web,
    `${PREFIX}/haive-customer-web@${digests.web}`,
  );
});

test('contracting migrations are derived from the record commit', async (t) => {
  const f = fixture(t, { contractingSnapshot: true });
  rmSync(join(f.root, 'packages/database/migrations/0001_record.sql'));
  assert.equal(await f.invoke(), 0, f.logs.join('\n'));
  assert.equal(JSON.parse(readFileSync(f.manifest, 'utf8')).contracts, true);
});

test('a destination that appears between gates and push is refused', async (t) => {
  const f = fixture(t, { appeared: 'worker' });
  assert.equal(await f.invoke(), 1);
  assert.deepEqual(f.attempted, ['api']);
  assert.equal(existsSync(f.manifest), false);
});

test('an interrupted run cannot push', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke([], { signal: AbortSignal.abort() }), 2);
  assert.deepEqual(f.attempted, []);
});

test('invalid options fail before gates or pushes', async (t) => {
  for (const args of [
    ['--timeout-ms', '0'],
    ['--timeout-ms', 'NaN'],
    ['--timeout-ms', '600001'],
    ['--registry', 'user:password@registry.test'],
    ['--registry', PREFIX, '--registry', PREFIX],
  ]) {
    const f = fixture(t);
    assert.equal(await f.invoke(args), 2);
    assert.deepEqual(f.attempted, []);
    assert.equal(f.bootCalls.length, 0);
  }
});

test('stock repoDigest cannot carry userinfo', async (t) => {
  const f = fixture(t, {
    editRecord: (r) => {
      r.images.web.repoDigest = `user:password@registry.test/web@${digests.web}`;
    },
  });
  assert.equal(await f.invoke(), 2);
  assert.deepEqual(f.attempted, []);
  assert.ok(!f.logs.join('\n').includes('user:password'));
});

test('an existing manifest is preserved without publishing', async (t) => {
  const f = fixture(t);
  mkdirSync(f.out);
  writeFileSync(f.manifest, 'previous manifest');
  assert.equal(
    await f.invoke([], {
      bootCheck: async () => 0,
      runner: async (cmd, args, options) => {
        if (cmd === 'docker' && args[0] === 'image' && args[1] === 'inspect')
          return ok(IDS[KEYS.find((host) => f.record.images[host].ref === args.at(-1))]);
        if (cmd === 'docker' && args[2] === 'inspect')
          return ok(JSON.stringify({ digest: digests.api }));
        assert.fail('no publishing command is allowed');
      },
    }),
    1,
  );
  assert.equal(readFileSync(f.manifest, 'utf8'), 'previous manifest');
});
