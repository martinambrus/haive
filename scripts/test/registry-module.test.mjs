import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { REGISTRY_MODULE_MAX_PACK_BYTES, registryModuleExports } from '../registry-module.mjs';

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

test('pins the production pack limit to 100 MiB', () => {
  assert.equal(REGISTRY_MODULE_MAX_PACK_BYTES, 100 * 1024 * 1024);
});

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
