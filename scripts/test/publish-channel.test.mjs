import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parseReleaseManifest } from '../../packages/shared/src/release/manifest.ts';
import { run } from '../publish-channel.mjs';

const KEYS = ['api', 'worker', 'web', 'builder'];
const DESTINATIONS = [...KEYS, 'release'];
const PREFIX = '127.0.0.1:5050/vendor';
const IDS = Object.fromEntries(
  DESTINATIONS.map((host, i) => [host, `sha256:${String(i + 1).repeat(64)}`]),
);
const bodies = Object.fromEntries(
  DESTINATIONS.map((host) => [
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
  DESTINATIONS.map((host) => [
    host,
    `sha256:${createHash('sha256').update(bodies[host]).digest('hex')}`,
  ]),
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
    schema: 2,
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
  const out = join(dir, config.outName ?? 'out');
  const manifest = join(out, 'release.json');
  const calls = [];
  const requests = [];
  const logs = [];
  const published = new Set();
  const runtimeDigestsRead = new Set();
  const localTags = new Map(Object.values(record.images).map((image) => [image.ref, image.id]));
  const priorLocalId = `sha256:${'e'.repeat(64)}`;
  if (config.existingLocal)
    localTags.set(
      `${config.localPrefix ?? PREFIX}/haive-customer-${config.existingLocal}:9.9.9`,
      priorLocalId,
    );
  const attempted = [];
  const bootCalls = [];
  const inspections = new Map();
  let archiveHost;
  let idReads = 0;
  let releaseBytes;
  const runner = async (cmd, args, options) => {
    calls.push({ cmd, args });
    assert.ok(options.timeout > 0);
    if (!config.existingManifest && runtimeDigestsRead.size < KEYS.length)
      assert.ok(!existsSync(manifest), 'manifest is absent until runtime images finish');
    if (config.abortOn?.(cmd, args)) options.signal?.throwIfAborted();
    if (cmd === 'docker') {
      if (args[0] === 'image' && args[1] === 'inspect') {
        const host = KEYS.find((key) => record.images[key].ref === args.at(-1));
        if (!host) {
          const id = localTags.get(args.at(-1));
          return id ? ok(id) : { status: 1, stderr: 'No such image' };
        }
        idReads++;
        return ok(
          config.mismatch === host || (config.retagAfterBoot && idReads > KEYS.length)
            ? `sha256:${'f'.repeat(64)}`
            : IDS[host],
        );
      }
      if (args[0] === 'image' && args[1] === 'save') {
        archiveHost = args.at(-1).includes('customer-release:')
          ? 'release'
          : DESTINATIONS.find((host) => IDS[host] === args.at(-1));
        assert.equal(args[args.indexOf('--platform') + 1], record.platform);
        return config.saveFailure || (config.releaseSaveFailure && archiveHost === 'release')
          ? { status: 1 }
          : ok();
      }
      if (args[0] === 'image' && args[1] === 'tag') {
        if (config.tagFailure) return { status: 1 };
        localTags.set(args.at(-1), args.at(-2));
        return ok();
      }
      if (args[0] === 'image' && args[1] === 'rm') {
        assert.equal(options.signal, undefined, 'cleanup ignores an aborted signal');
        if (config.localCleanupFailure) return { status: 1 };
        if (!localTags.has(args.at(-1))) return { status: 1, stderr: 'removal refused' };
        localTags.delete(args.at(-1));
        return ok();
      }
      if (args[0] === 'buildx' && args[1] === 'build') {
        assert.deepEqual(attempted, KEYS, 'release build follows every runtime push');
        assert.ok(existsSync(manifest), 'release build follows the local write');
        const context = args.at(-1);
        assert.deepEqual(readdirSync(context).sort(), ['Dockerfile', 'release.json']);
        assert.equal(
          readFileSync(join(context, 'Dockerfile'), 'utf8'),
          'FROM scratch\nCOPY release.json /release.json\nLABEL org.haive.release=1\n',
        );
        if (!config.releaseBuildBeforeLoadFailure)
          localTags.set(args[args.indexOf('--tag') + 1], IDS.release);
        releaseBytes = readFileSync(join(context, 'release.json'));
        assert.deepEqual(releaseBytes, readFileSync(manifest));
        assert.equal(args[args.indexOf('--platform') + 1], record.platform);
        assert.ok(args.includes('--load'));
        assert.ok(!args.includes('--push'));
        return config.releaseBuildFailure || config.releaseBuildBeforeLoadFailure
          ? { status: 1 }
          : ok();
      }
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
        const host = DESTINATIONS.find((key) => ref.includes(`customer-${key}:`));
        inspections.set(host, (inspections.get(host) ?? 0) + 1);
        if (config.releaseAbsenceFailure && host === 'release' && inspections.get(host) > 1)
          throw new Error('release absence check failed');
        if (config.inspectCaptureError) return { status: 1, error: new Error('transport failed') };
        if (
          config.existing === host ||
          published.has(host) ||
          (config.appeared === host && inspections.get(host) > 1)
        ) {
          if (KEYS.includes(host) && published.has(host) && config.rereadMismatch !== host)
            runtimeDigestsRead.add(host);
          return ok(
            JSON.stringify({ digest: config.rereadMismatch === host ? IDS.api : digests[host] }),
          );
        }
        if (config.rereadFailure === host && attempted.includes(host)) return { status: 1 };
        return {
          status: 1,
          stderr:
            (typeof config.inspectError === 'function'
              ? config.inspectError(ref)
              : config.inspectError) ?? `ERROR: ${ref}: not found`,
        };
      }
      const push = args[0] === 'push';
      const copy = args[0] === 'buildx' && args[2] === 'create';
      if (push || copy) {
        const ref = copy ? args[args.indexOf('--tag') + 1] : args.at(-1);
        const host = DESTINATIONS.find((key) => ref.includes(`customer-${key}:`));
        attempted.push(host);
        if (config.pushFailure === host) {
          config.abortPush?.();
          return { status: 1, stderr: 'push failed' };
        }
        if (copy) {
          assert.ok(args.includes('--prefer-index=false'));
          assert.equal(args.at(-1), `${PREFIX}/haive-web@${digests.web}`);
        } else assert.equal(args[args.indexOf('--platform') + 1], record.platform);
        if (config.rereadFailure !== host) published.add(host);
        if (config.prematureManifest && host === 'builder')
          writeFileSync(manifest, 'premature manifest');
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
    if (config.request) return config.request(url, options);
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
    localTags,
    priorLocalId,
    root,
    out,
    manifest,
    record,
    calls,
    requests,
    logs,
    attempted,
    bootCalls,
    get releaseBytes() {
      return releaseBytes;
    },
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
  assert.deepEqual(f.attempted, DESTINATIONS);
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
  assert.equal(f.requests.length, 5);
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
  assert.equal(f.calls.filter(({ args }) => args[0] === 'push').length, 5);
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

for (const [host, code, attempted] of [
  ['api', 1, []],
  ['worker', 2, ['api']],
  ['web', 2, ['api', 'worker']],
]) {
  test(`a ${host} destination appearing before push returns ${code}`, async (t) => {
    const f = fixture(t, { appeared: host });
    assert.equal(await f.invoke(), code);
    assert.deepEqual(f.attempted, attempted);
    assert.equal(existsSync(f.manifest), false);
  });
}

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
  const f = fixture(t, { existingManifest: true });
  mkdirSync(f.out);
  writeFileSync(f.manifest, 'previous manifest');
  assert.equal(await f.invoke(), 2);
  assert.deepEqual(f.attempted, []);
  assert.equal(readFileSync(f.manifest, 'utf8'), 'previous manifest');
  assert.match(f.logs.join('\n'), /manifest already exists/);
  assert.ok(
    KEYS.every((host) => f.requests.some(({ url }) => url.includes(`customer-${host}/manifests/`))),
  );
});

const TOKEN = 't352-anonymous-token-never-log';
const destination = (host) => `${PREFIX}/haive-customer-${host}:9.9.9`;
function tokenRegistry({
  tokenStatus = 200,
  secondStatus = 404,
  realm = 'https://127.0.0.1:5050/token',
} = {}) {
  return async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/token') {
      return {
        status: tokenStatus,
        json: async () =>
          tokenStatus === 200 ? { token: TOKEN } : { errors: [{ code: 'DENIED' }] },
      };
    }
    if (options.headers.Authorization) {
      return {
        status: secondStatus,
        json: async () => ({ errors: [{ code: 'MANIFEST_UNKNOWN' }] }),
      };
    }
    const repository = parsed.pathname.slice(4, parsed.pathname.indexOf('/manifests/'));
    return {
      status: 401,
      headers: new Headers({
        'www-authenticate': `Bearer realm="${realm}",service="registry-test",scope="repository:${repository}:pull"`,
      }),
      json: async () => ({ errors: [{ code: 'UNAUTHORIZED' }] }),
    };
  };
}

function assertTokenRequests(requests) {
  for (const { url, options } of requests) {
    const parsed = new URL(url);
    assert.equal(options.redirect, 'error');
    assert.equal(parsed.host, '127.0.0.1:5050');
    if (parsed.pathname === '/token') {
      assert.equal(parsed.protocol, 'https:');
      assert.equal(parsed.searchParams.get('service'), 'registry-test');
      assert.match(
        parsed.searchParams.get('scope'),
        /^repository:vendor\/haive-customer-(api|worker|web|builder|release):pull$/,
      );
      assert.ok(!options.headers.Authorization);
    } else if (options.headers.Authorization) {
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    }
  }
}

for (const config of [{}, { tokenStatus: 403 }, { tokenStatus: 401 }, { secondStatus: 401 }]) {
  test(`Bearer absence proof ${JSON.stringify(config)} publishes without exposing a token`, async (t) => {
    const f = fixture(t, { request: tokenRegistry(config) });
    assert.equal(await f.invoke(), 0, f.logs.join('\n'));
    assert.deepEqual(f.attempted, DESTINATIONS);
    assert.match(
      f.logs.join('\n'),
      config.tokenStatus || config.secondStatus ? /daemon-only/ : /corroborated/,
    );
    assertTokenRequests(f.requests);
    assert.ok(f.requests.some(({ url }) => new URL(url).pathname === '/token'));
    assert.ok(!JSON.stringify({ calls: f.calls, logs: f.logs }).includes(TOKEN));
  });
}

test('token DENIED plus daemon authorization failure refuses and names the unproven ref', async (t) => {
  const f = fixture(t, {
    request: tokenRegistry({ tokenStatus: 403 }),
    inspectError: 'ERROR: failed to authorize: 403 Forbidden',
  });
  assert.equal(await f.invoke(), 2);
  assert.deepEqual(f.attempted, []);
  assertTokenRequests(f.requests);
  assert.ok(f.requests.some(({ url }) => new URL(url).pathname === '/token'));
  assert.ok(
    f.logs.some((line) => line.includes(`absence of ${destination('api')} could not be proven`)),
  );
});

test('exact confirmations permit only access-denied destinations and are loud in the plan', async (t) => {
  const f = fixture(t, {
    request: tokenRegistry({ tokenStatus: 403 }),
    inspectError:
      'ERROR: failed to authorize: failed to fetch anonymous token: unexpected status from GET request to https://127.0.0.1:5050/token: 403 Forbidden',
  });
  assert.equal(
    await f.invoke(DESTINATIONS.flatMap((host) => ['--confirm-absent', destination(host)])),
    0,
    f.logs.join('\n'),
  );
  assert.deepEqual(f.attempted, DESTINATIONS);
  assertTokenRequests(f.requests);
  for (const host of DESTINATIONS)
    assert.ok(
      f.logs.some((line) => line.includes(`WARNING: --confirm-absent ${destination(host)}`)),
    );
});

for (const config of [
  { httpStatus: 500 },
  { fetchError: true },
  { request: tokenRegistry({ tokenStatus: 500 }) },
  { request: tokenRegistry({ secondStatus: 500 }) },
  { request: tokenRegistry({ tokenStatus: 403 }), inspectError: 'connection refused: not found' },
]) {
  test(`confirmation fails closed for transport or untrusted proof ${Object.keys(config)}`, async (t) => {
    const f = fixture(t, config);
    assert.equal(await f.invoke(['--confirm-absent', destination('api')]), 2);
    assertTokenRequests(f.requests);
    assert.deepEqual(f.attempted, []);
    assert.ok(
      f.logs.some((line) => line.includes(`absence of ${destination('api')} could not be proven`)),
    );
  });
}

test('confirmation cannot override a present destination', async (t) => {
  const f = fixture(t, { existing: 'api' });
  assert.equal(await f.invoke(['--confirm-absent', destination('api')]), 1);
  assert.deepEqual(f.attempted, []);
});

test('confirmation must name an exact destination', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke(['--confirm-absent', `${PREFIX}/other:9.9.9`]), 2);
  assert.deepEqual(f.attempted, []);
  assert.equal(f.bootCalls.length, 0);
  assert.match(f.logs.join('\n'), /--confirm-absent is not a destination/);
});

test('dry-run refuses an existing manifest just like publication', async (t) => {
  const f = fixture(t, { existingManifest: true });
  mkdirSync(f.out);
  writeFileSync(f.manifest, 'previous manifest');
  assert.equal(await f.invoke(['--dry-run']), 2);
  assert.deepEqual(f.attempted, []);
  assert.equal(readFileSync(f.manifest, 'utf8'), 'previous manifest');
  assert.match(f.logs.join('\n'), /manifest already exists/);
});

for (const [name, inspectError] of [
  [
    'credential helper executable file not found in $PATH',
    'error getting credentials - err: exec: "docker-credential-desktop.exe": executable file not found in $PATH',
  ],
  [
    'authorization failure together with not found',
    (ref) => `ERROR: ${ref}: not found\nERROR: failed to authorize: 403 Forbidden: not found`,
  ],
  [
    'not-found line for another ref',
    (ref) => `ERROR: ${ref.replace('customer', 'another')}: not found`,
  ],
  [
    'not-found line with a regex lookalike ref',
    (ref) => `ERROR: ${ref.replace('127.0.0.1', '127x0x0x1')}: not found`,
  ],
  [
    'not-found wording embedded in another error',
    (ref) => `unexpected wrapper: ERROR: ${ref}: not found`,
  ],
]) {
  test(`daemon absence refuses ${name} without confirmation`, async (t) => {
    const f = fixture(t, { request: tokenRegistry({ tokenStatus: 403 }), inspectError });
    assert.equal(await f.invoke(), 2);
    assertTokenRequests(f.requests);
    assert.deepEqual(f.attempted, []);
    assert.ok(!existsSync(f.manifest));
    assert.match(f.logs.join('\n'), /could not be proven/);
  });
}

test('daemon absence accepts the exact ref containing tls and version 1.0.500', async (t) => {
  const f = fixture(t, {
    request: async () => ({ status: 403 }),
    editRecord: (record) => {
      record.tag = 'v1.0.500';
      record.version = '1.0.500';
      for (const image of Object.values(record.images))
        image.ref = image.ref.replace('/vendor/', '/atlstudio/').replace(':9.9.9', ':1.0.500');
    },
  });
  assert.equal(await f.invoke(['--dry-run']), 0, f.logs.join('\n'));
  assert.equal(f.logs.filter((line) => line.includes('daemon-only')).length, 5);
  assert.deepEqual(f.attempted, []);
  assert.ok(!existsSync(f.manifest));
});

test('daemon absence word-bounds transport tokens outside a multiline exact proof', async (t) => {
  const f = fixture(t, {
    request: async () => ({ status: 403 }),
    inspectError: (ref) =>
      `networking connectionless atls xeofx status500\nERROR: ${ref}: not found\nend`,
  });
  assert.equal(await f.invoke(['--dry-run']), 0, f.logs.join('\n'));
  assert.equal(f.logs.filter((line) => line.includes('daemon-only')).length, 5);
  assert.deepEqual(f.attempted, []);
});

for (const [name, realm] of [
  ['foreign host', 'https://another-host.test/token'],
  ['non-https', 'http://127.0.0.1:5050/token'],
  ['username', 'https://operator@127.0.0.1:5050/token'],
  ['password', 'https://:secret@127.0.0.1:5050/token'],
  ['fragment', 'https://127.0.0.1:5050/token#fragment'],
]) {
  test(`untrusted Bearer realm ${name} refuses before any token request`, async (t) => {
    const f = fixture(t, { request: tokenRegistry({ realm }) });
    assert.equal(await f.invoke(['--confirm-absent', destination('api')]), 2);
    assertTokenRequests(f.requests);
    assert.deepEqual(f.attempted, []);
    assert.ok(!existsSync(f.manifest));
    assert.ok(f.requests.every(({ url }) => new URL(url).host === '127.0.0.1:5050'));
    assert.ok(!f.requests.some(({ url }) => new URL(url).pathname === '/token'));
    assert.ok(f.requests.every(({ options }) => !options.headers.Authorization));
    assert.deepEqual(
      f.requests.map(({ url }) => url),
      ['http://127.0.0.1:5050/v2/vendor/haive-customer-api/manifests/9.9.9'],
    );
    assert.match(f.logs.join('\n'), /could not be proven/);
  });
}

test('usage describes local manifest delivery without a board task ID', async () => {
  const logs = [];
  assert.equal(await run(['--help'], { say: (line) => logs.push(line) }), 0);
  assert.match(
    logs.join('\n'),
    /— writes release\.json locally and publishes its manifest image last$/,
  );
  assert.doesNotMatch(logs.join('\n'), /\bT\d+\b/);
});

test('control: a record without builder refuses before gates or pushes', async (t) => {
  const f = fixture(t, {
    editRecord: (r) => {
      r.schema = 1;
      delete r.images.builder;
    },
  });
  assert.equal(await f.invoke(['--dry-run']), 2, f.logs.join('\n'));
  assert.match(f.logs.join('\n'), /record has no builder \(schema 1\); rebuild the channel/);
  assert.deepEqual(f.attempted, []);
  assert.equal(f.bootCalls.length, 0);
});

test('control: release push follows the local write and every other push with identical bytes', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke(), 0, f.logs.join('\n'));
  assert.deepEqual(f.attempted, DESTINATIONS);
  assert.deepEqual(f.releaseBytes, readFileSync(f.manifest));
});

test('control: existing release destination refuses before any push even with confirmation', async (t) => {
  const f = fixture(t, { existing: 'release' });
  assert.equal(await f.invoke(['--confirm-absent', destination('release')]), 1, f.logs.join('\n'));
  assert.deepEqual(f.attempted, []);
});

for (const kind of ['pushFailure', 'rereadFailure', 'rereadMismatch']) {
  test(`release ${kind} returns 2, preserves the local file and reports attempted refs`, async (t) => {
    const f = fixture(t, { [kind]: 'release' });
    assert.equal(await f.invoke(), 2, f.logs.join('\n'));
    assert.ok(existsSync(f.manifest));
    assert.deepEqual(f.attempted, DESTINATIONS);
    assert.match(f.logs.join('\n'), /attempted: .*customer-release/);
    assert.doesNotMatch(f.logs.at(-1), /no manifest written/);
  });
}

test('control: manifest-image context round-trips local release bytes', async (t) => {
  const f = fixture(t);
  assert.equal(await f.invoke(), 0, f.logs.join('\n'));
  assert.ok(Buffer.isBuffer(f.releaseBytes), 'a manifest image was built');
  assert.deepEqual(f.releaseBytes, readFileSync(f.manifest));
});

test('a failed release build retains the local manifest and returns 2 after runtime pushes', async (t) => {
  const f = fixture(t, { releaseBuildFailure: true });
  assert.equal(await f.invoke(), 2, f.logs.join('\n'));
  assert.ok(existsSync(f.manifest));
  assert.deepEqual(f.attempted, KEYS);
  assert.match(f.logs.at(-1), /local manifest retained/);
});

for (const phase of ['fetch resolves', 'fetch rejects', 'body rejects']) {
  test(`registry abort during ${phase} preserves the interruption reason`, async (t) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('operator interrupted publication'));
    const f = fixture(t, {
      request: async () => {
        if (phase === 'body rejects')
          return {
            status: 404,
            json: async () => {
              abort();
              throw new Error('body stopped');
            },
          };
        abort();
        if (phase === 'fetch rejects') throw new Error('fetch stopped');
        return { status: 404 };
      },
    });
    assert.equal(await f.invoke([], { signal: controller.signal }), 2);
    assert.deepEqual(f.attempted, []);
    assert.match(f.logs.join('\n'), /operator interrupted publication/);
    assert.doesNotMatch(f.logs.join('\n'), /absence of .*could not be proven/);
  });
}

const LOCAL_TEST_PREFIX = '127.0.0.1:5051/other';
const localDestination = (host) => destination(host).replace(PREFIX, LOCAL_TEST_PREFIX);

for (const host of ['api', 'worker', 'builder', 'release']) {
  test(`failed ${host} push removes only its new local destination tag`, async (t) => {
    const f = fixture(t, { pushFailure: host });
    assert.equal(await f.invoke(['--registry', LOCAL_TEST_PREFIX]), 2);
    assert.equal(f.localTags.has(localDestination(host)), false);
    assert.ok(
      f.calls.some(
        ({ args }) =>
          args[0] === 'image' && args[1] === 'rm' && args.at(-1) === localDestination(host),
      ),
    );
    assert.equal(
      f.localTags.get(
        `${PREFIX}/haive-${host === 'release' ? 'customer-api' : 'customer-' + host}:9.9.9`,
      ),
      host === 'release' ? IDS.api : IDS[host],
    );
  });
}

test('a failed push restores a pre-existing local destination tag', async (t) => {
  const f = fixture(t, {
    pushFailure: 'api',
    existingLocal: 'api',
    localPrefix: LOCAL_TEST_PREFIX,
  });
  assert.equal(await f.invoke(['--registry', LOCAL_TEST_PREFIX]), 2);
  assert.equal(f.localTags.get(localDestination('api')), f.priorLocalId);
});

test('an aborted push still removes its new local destination tag', async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { pushFailure: 'builder', abortPush: () => controller.abort() });
  assert.equal(await f.invoke(['--registry', LOCAL_TEST_PREFIX], { signal: controller.signal }), 2);
  assert.equal(f.localTags.has(localDestination('builder')), false);
});

test('failed local tag cleanup is reported and keeps exit 2', async (t) => {
  const f = fixture(t, { pushFailure: 'worker', localCleanupFailure: true });
  assert.equal(await f.invoke(['--registry', LOCAL_TEST_PREFIX]), 2);
  assert.match(f.logs.join('\n'), /cleanup failed.*local tag.*customer-worker/);
});

for (const [stage, config, host] of [
  ['tag', { tagFailure: true }, 'api'],
  ['build before load', { releaseBuildBeforeLoadFailure: true }, 'release'],
]) {
  test(`failed ${stage} leaves no local tag and reports no cleanup failure`, async (t) => {
    const f = fixture(t, config);
    assert.equal(await f.invoke(['--registry', LOCAL_TEST_PREFIX]), 2);
    assert.equal(f.localTags.has(localDestination(host)), false);
    assert.doesNotMatch(f.logs.join('\n'), /cleanup failed; local tag retained/);
    const cleanup = f.calls.findIndex(
      ({ args }) =>
        args[0] === 'image' && args[1] === 'rm' && args.at(-1) === localDestination(host),
    );
    assert.ok(cleanup >= 0);
    assert.ok(
      f.calls
        .slice(cleanup + 1)
        .some(
          ({ args }) =>
            args[0] === 'image' && args[1] === 'inspect' && args.at(-1) === localDestination(host),
        ),
      'failed removal re-inspects the ref instead of reading removal diagnostics',
    );
  });
}

for (const word of ['connections', 'timeouts', 'networks', 'certificates', 'credential helpers']) {
  test(`plural transport diagnostic ${word} refuses even alongside an exact absence line`, async (t) => {
    const f = fixture(t, {
      request: async () => ({ status: 403 }),
      inspectError: (ref) => `ERROR: ${ref}: not found\nmultiple ${word} failed`,
    });
    assert.equal(await f.invoke(['--dry-run', '--confirm-absent', destination('api')]), 2);
    assert.deepEqual(f.attempted, []);
    assert.equal(f.requests.length, 0);
    assert.match(f.logs.join('\n'), /absence of .*could not be proven/);
  });
}

for (const failure of [
  { releaseBuildFailure: true },
  { pushFailure: 'release' },
  { rereadFailure: 'release' },
  { rereadMismatch: 'release' },
]) {
  test(`retained manifest recovery rebuilds and pushes identical bytes: ${JSON.stringify(failure)}`, async (t) => {
    const f = fixture(t, { ...failure, outName: "out with ' quotes $(false)" });
    assert.equal(await f.invoke(), 2);
    assert.match(f.logs.join('\n'), /recovery: inspect .*customer-release.* before retrying/);
    const recovery = f.logs.find((line) => line.startsWith('publish-channel: recovery command: '));
    assert.ok(recovery, f.logs.join('\n'));
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    const captured = join(f.root, 'recovery.jsonl');
    const docker = join(bin, 'docker');
    writeFileSync(
      docker,
      `#!${process.execPath}
import {appendFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
const build=args[0]==='buildx' && args[1]==='build';
appendFileSync(${JSON.stringify(captured)}, JSON.stringify({args, ...(build ? {body:readFileSync(join(args.at(-1),'release.json'),'utf8'), dockerfile:readFileSync(join(args.at(-1),'Dockerfile'),'utf8')} : {})})+'\\n');
`,
    );
    chmodSync(docker, 0o700);
    const result = spawnSync(
      'sh',
      ['-c', recovery.slice('publish-channel: recovery command: '.length)],
      {
        cwd: f.root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = readFileSync(captured, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(0, -1), [
      'buildx',
      'build',
      '--platform',
      'linux/amd64',
      '--load',
      '--tag',
      destination('release'),
    ]);
    assert.equal(calls[0].body, readFileSync(f.manifest, 'utf8'));
    assert.equal(
      calls[0].dockerfile,
      'FROM scratch\nCOPY release.json /release.json\nLABEL org.haive.release=1\n',
    );
    assert.deepEqual(calls[1].args, ['push', '--platform', 'linux/amd64', destination('release')]);
    assert.equal(existsSync(calls[0].args.at(-1)), false, 'recovery context removed');
    assert.doesNotMatch(recovery, /\bT\d+\b/);
  });
}

for (const failure of ['releaseAbsenceFailure', 'releaseSaveFailure']) {
  for (const preExisting of [false, true]) {
    test(`${failure} before release push restores the local tag (pre-existing: ${preExisting})`, async (t) => {
      const f = fixture(t, {
        [failure]: true,
        ...(preExisting ? { existingLocal: 'release' } : {}),
      });
      assert.equal(await f.invoke(), 2);
      assert.deepEqual(f.attempted, KEYS);
      assert.ok(existsSync(f.manifest));
      assert.ok(f.releaseBytes, 'the release image was loaded before the failure');
      assert.equal(
        f.localTags.get(destination('release')),
        preExisting ? f.priorLocalId : undefined,
      );
      assert.match(f.logs.join('\n'), /local manifest retained/);
    });
  }
}

test('the manifest guard covers the digest re-read after the fourth runtime push', async (t) => {
  const f = fixture(t, { prematureManifest: true });
  assert.equal(await f.invoke(), 2);
  assert.deepEqual(f.attempted, KEYS);
  assert.match(f.logs.join('\n'), /manifest is absent until runtime images finish/);
  assert.ok(
    f.calls.some(({ args }) => args[2] === 'inspect' && args.at(-1) === destination('builder')),
  );
  assert.equal(f.releaseBytes, undefined, 'release build never starts');
});
