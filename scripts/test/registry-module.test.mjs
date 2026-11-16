import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { capture } from '../build-channel.mjs';
import {
  REGISTRY_MODULE_MAX_MANIFEST_BYTES,
  REGISTRY_MODULE_MAX_PACK_BYTES,
  registryModuleExports,
} from '../registry-module.mjs';

for (const [label, requestedVersion, name, version, accepted] of [
  ['spec build metadata', '1.0.0+build.5', '@haive-module/demo', '1.0.0', true],
  ['stored build metadata', '1.0.0', '@haive-module/demo', '1.0.0+build.6', true],
  ['different build metadata', '1.0.0+build.5', '@haive-module/demo', '1.0.0+build.6', true],
  ['matching prerelease', '1.0.0-rc.1+build.5', '@haive-module/demo', '1.0.0-rc.1', true],
  ['different prerelease', '1.0.0-rc.1+build.5', '@haive-module/demo', '1.0.0-rc.2', false],
  ['different release', '1.0.0+build.5', '@haive-module/demo', '1.0.1', false],
  ['different name', '1.0.0+build.5', '@haive-module/other', '1.0.0', false],
]) {
  test(`packed identity: ${label}`, async () => {
    const exports = { './manifest': './manifest.js' };
    const read = () =>
      registryModuleExports(`@haive-module/demo@${requestedVersion}`, {
        cwd: tmpdir(),
        env: {},
        command: async (cmd) => {
          if (cmd === 'pnpm') return { stdout: '' };
          if (cmd === 'npm')
            return { stdout: JSON.stringify([{ filename: 'demo.tgz', size: 256 }]) };
          return { stdout: JSON.stringify({ name, version, exports }) };
        },
      });
    if (accepted) assert.deepEqual(await read(), exports);
    else await assert.rejects(read, /packed module identity differs/);
  });
}

for (const identity of ['matching', 'different']) {
  test(`reads a real packed manifest when registry exports are absent (${identity} identity)`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-module-test-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'package'));
    const exports = { './manifest': './dist/manifest.js', './web': './dist/web.js' };
    writeFileSync(
      join(dir, 'package/package.json'),
      JSON.stringify({
        name: '@haive-module/demo',
        version: identity === 'matching' ? '1.0.0' : '2.0.0',
        exports,
      }),
    );
    let scratch;
    const calls = [];
    const read = () =>
      registryModuleExports('@haive-module/demo@1.0.0', {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          LANG: 'C',
          NPM_CONFIG_USERCONFIG: '/private/npmrc',
          TAR_OPTIONS: '--invalid-option',
        },
        command: async (cmd, args, options) => {
          calls.push(cmd);
          if (cmd === 'pnpm') return { stdout: '' };
          if (cmd === 'npm') {
            assert.ok(args.includes('--ignore-scripts'));
            assert.equal(options.cwd, dir);
            scratch = args.at(-1);
            assert.equal(options.env.NPM_CONFIG_USERCONFIG, '/private/npmrc');
            assert.equal(options.env.npm_config_cache, join(scratch, 'cache'));
            assert.equal(
              spawnSync('tar', ['-czf', join(scratch, 'demo.tgz'), '-C', dir, 'package']).status,
              0,
            );
            return { stdout: JSON.stringify([{ filename: 'demo.tgz', size: 256 }]) };
          }
          assert.deepEqual(options.env, { PATH: process.env.PATH, LANG: 'C' });
          assert.ok(args.includes('--occurrence=1'));
          const result = spawnSync(cmd, args, { ...options, encoding: 'utf8' });
          assert.equal(result.status, 0, result.stderr);
          return result;
        },
      });
    if (identity === 'matching') assert.deepEqual(await read(), exports);
    else await assert.rejects(read, /identity differs/);
    assert.deepEqual(calls, ['pnpm', 'npm', 'tar']);
    assert.equal(existsSync(scratch), false);
  });
}

test('refuses oversized pack metadata before reading tar, with an injectable byte limit', async () => {
  let scratch;
  const calls = [];
  await assert.rejects(
    registryModuleExports('@haive-module/demo@1.0.0', {
      cwd: tmpdir(),
      env: {},
      maxPackBytes: 4,
      command: async (cmd, args) => {
        calls.push(cmd);
        if (cmd === 'pnpm') return { stdout: '' };
        scratch = args.at(-1);
        return { stdout: JSON.stringify([{ filename: 'demo.tgz', size: 5 }]) };
      },
    }),
    /packed module exceeds size limit/,
  );
  assert.deepEqual(calls, ['pnpm', 'npm']);
  assert.equal(existsSync(scratch), false);
});

for (const [label, size] of [
  ['missing', undefined],
  ['string', '256'],
  ['null', null],
  ['fractional', 1.5],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
]) {
  test(`refuses ${label} pack size before reading tar`, async () => {
    let scratch;
    const calls = [];
    await assert.rejects(
      registryModuleExports('@haive-module/demo@1.0.0', {
        cwd: tmpdir(),
        env: {},
        command: async (cmd, args) => {
          calls.push(cmd);
          if (cmd === 'pnpm') return { stdout: '' };
          if (cmd === 'npm') {
            scratch = args.at(-1);
            return { stdout: JSON.stringify([{ filename: 'demo.tgz', size }]) };
          }
          return { stdout: JSON.stringify({ name: '@haive-module/demo', version: '1.0.0' }) };
        },
      }),
      /packed module exceeds size limit/,
    );
    assert.deepEqual(calls, ['pnpm', 'npm']);
    assert.equal(existsSync(scratch), false);
  });
}

test('pins the production pack limit to 100 MiB', () => {
  assert.equal(REGISTRY_MODULE_MAX_PACK_BYTES, 100 * 1024 * 1024);
});

test('pins the production manifest limit to 1 MiB', () => {
  assert.equal(REGISTRY_MODULE_MAX_MANIFEST_BYTES, 1024 * 1024);
});

test('oversized tar manifest stops capture at an injected limit and keeps the manifest error', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-module-cap-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'package'));
  writeFileSync(
    join(dir, 'package/package.json'),
    JSON.stringify({ description: 'x'.repeat(4096) }),
  );
  const maxManifestBytes = 128;
  let scratch;
  let captured;
  await assert.rejects(
    registryModuleExports('@haive-module/demo@1.0.0', {
      cwd: dir,
      env: { PATH: process.env.PATH },
      maxManifestBytes,
      command: async (cmd, args, options) => {
        if (cmd === 'pnpm') return { stdout: '' };
        if (cmd === 'npm') {
          scratch = args.at(-1);
          assert.equal(
            spawnSync('tar', ['-czf', join(scratch, 'demo.tgz'), '-C', dir, 'package']).status,
            0,
          );
          return { stdout: JSON.stringify([{ filename: 'demo.tgz', size: 256 }]) };
        }
        assert.equal(options.maxBuffer, maxManifestBytes);
        captured = await capture(cmd, args, { ...options, timeout: 1000, killGrace: 10 });
        if (captured.error) throw new Error('tar failed', { cause: captured.error });
        return captured;
      },
    }),
    /packed module manifest exceeds 1 MiB: @haive-module\/demo@1\.0\.0/,
  );
  assert.equal(captured.error.code, 'ENOBUFS');
  assert.ok(Buffer.byteLength(captured.stdout) <= maxManifestBytes);
  assert.equal(existsSync(scratch), false);
});

for (const oversized of [false, true]) {
  test(`manifest at ${oversized ? 'one byte over' : 'exactly'} the byte limit`, async () => {
    const stdout = JSON.stringify({
      name: '@haive-module/demo',
      version: '1.0.0',
      exports: { './manifest': './manifest.js' },
      description: 'é',
    });
    let scratch;
    const calls = [];
    const read = () =>
      registryModuleExports('@haive-module/demo@1.0.0', {
        cwd: tmpdir(),
        env: {},
        maxManifestBytes: Buffer.byteLength(stdout) - (oversized ? 1 : 0),
        command: async (cmd, args) => {
          calls.push(cmd);
          if (cmd === 'pnpm') return { stdout: '' };
          if (cmd === 'npm') {
            scratch = args.at(-1);
            return { stdout: JSON.stringify([{ filename: 'demo.tgz', size: 256 }]) };
          }
          return { stdout };
        },
      });
    if (oversized) await assert.rejects(read, /packed module manifest exceeds 1 MiB/);
    else assert.deepEqual(await read(), { './manifest': './manifest.js' });
    assert.deepEqual(calls, ['pnpm', 'npm', 'tar']);
    assert.equal(existsSync(scratch), false);
  });
}

for (const files of [
  [],
  [
    { filename: 'a.tgz', size: 1 },
    { filename: 'b.tgz', size: 1 },
  ],
]) {
  test(`refuses ${files.length} packed files before tar`, async () => {
    let scratch;
    const calls = [];
    await assert.rejects(
      registryModuleExports('@haive-module/demo@1.0.0', {
        cwd: tmpdir(),
        env: {},
        command: async (cmd, args) => {
          calls.push(cmd);
          if (cmd === 'pnpm') return { stdout: '' };
          scratch = args.at(-1);
          return { stdout: JSON.stringify(files) };
        },
      }),
      /could not identify the packed module/,
    );
    assert.deepEqual(calls, ['pnpm', 'npm']);
    assert.equal(existsSync(scratch), false);
  });
}

for (const failed of [false, true]) {
  test(`cleanup failure preserves the ${failed ? 'original error' : 'successful result'} and names scratch`, async (t) => {
    let scratch;
    const warnings = [];
    const original = new Error('original npm failure');
    const read = () =>
      registryModuleExports('@haive-module/demo@1.0.0', {
        cwd: tmpdir(),
        env: {},
        removeScratch: () => {
          throw new Error('cleanup denied');
        },
        warn: (line) => warnings.push(line),
        command: async (cmd, args) => {
          if (cmd === 'pnpm') return { stdout: '' };
          if (cmd === 'npm') {
            scratch = args.at(-1);
            t.after(() => rmSync(scratch, { recursive: true, force: true }));
            if (failed) throw original;
            return { stdout: JSON.stringify([{ filename: 'demo.tgz', size: 256 }]) };
          }
          return {
            stdout: JSON.stringify({
              name: '@haive-module/demo',
              version: '1.0.0',
              exports: { './manifest': './manifest.js' },
            }),
          };
        },
      });
    if (failed) await assert.rejects(read, (error) => error === original);
    else assert.deepEqual(await read(), { './manifest': './manifest.js' });
    assert.deepEqual(warnings, [`registry-module: cleanup failed; leftover path ${scratch}`]);
    assert.equal(existsSync(scratch), true);
  });
}
