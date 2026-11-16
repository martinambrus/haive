import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registryModuleExports } from '../registry-module.mjs';

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
        env: { PATH: process.env.PATH, NPM_CONFIG_USERCONFIG: '/private/npmrc' },
        command: async (cmd, args, options) => {
          calls.push(cmd);
          if (cmd === 'pnpm') return { stdout: '' };
          if (cmd === 'npm') {
            assert.ok(args.includes('--ignore-scripts'));
            scratch = args.at(-1);
            assert.equal(options.env.NPM_CONFIG_USERCONFIG, '/private/npmrc');
            assert.equal(options.env.npm_config_cache, join(scratch, 'cache'));
            assert.equal(
              spawnSync('tar', ['-czf', join(scratch, 'demo.tgz'), '-C', dir, 'package']).status,
              0,
            );
            return { stdout: JSON.stringify([{ filename: 'demo.tgz' }]) };
          }
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
