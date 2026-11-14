import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkPublicModules } from '../check-public-modules.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (extra) =>
  new Map([
    ['public-modules.json', JSON.stringify(['public-one'])],
    ['modules/public-one/package.json', JSON.stringify({ name: '@haive/module-public-one' })],
    [
      'packages/api/package.json',
      JSON.stringify({ dependencies: { '@haive/module-public-one': 'workspace:*', ...extra } }),
    ],
  ]);
test('an unknown module dependency fails; public names come from the declared list', () => {
  assert.deepEqual(checkPublicModules(fixture({})), []);
  for (const name of ['@haive/module-private-one', '@haive-module/private-one']) {
    const errors = checkPublicModules(fixture({ [name]: 'workspace:*' }));
    assert.ok(
      errors.some((error) => error.includes('packages/api/package.json') && error.includes(name)),
      errors.join('\n'),
    );
  }
});
test('a private module tracked under modules cannot declare itself public', () => {
  const files = fixture({ '@haive/module-private-one': 'workspace:*' });
  files.set(
    'modules/private-one/package.json',
    JSON.stringify({ name: '@haive/module-private-one' }),
  );
  assert.ok(checkPublicModules(files).some((error) => error.includes('non-public module')));
  files.delete('modules/private-one/package.json');
  files.set('modules/private-one/src/index.ts', 'export {};');
  assert.ok(
    checkPublicModules(files).some((error) => error.includes('modules/private-one/src/index.ts')),
  );
});
test('a missing or malformed public module list fails closed', () => {
  for (const value of [undefined, '{}', '["Bad"]', '["public-one", "public-one"]']) {
    const files = fixture({});
    if (value === undefined) files.delete('public-modules.json');
    else files.set('public-modules.json', value);
    assert.ok(checkPublicModules(files).some((error) => error.includes('public-modules.json')));
  }
});
test('unknown lock importers, explicit workspace entries, registries and production references fail', () => {
  for (const [file, text] of [
    ['pnpm-lock.yaml', 'importers:\n  external-modules/private-one: {}'],
    ['pnpm-workspace.yaml', 'packages:\n  - modules/private-one'],
    ['packages/api/src/modules.generated.ts', "import m from '@haive-module/private-one/manifest'"],
    ['packages/worker/src/example.ts', "const pkg = '@haive/module-private-one'"],
  ]) {
    const files = fixture({});
    files.set(file, text);
    assert.ok(
      checkPublicModules(files).some((error) => error.includes(file)),
      file,
    );
  }
});
test('repository tracked install and runtime wiring contains only public modules', () => {
  const result = spawnSync('/usr/bin/git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const files = new Map(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((file) => [file, readFileSync(join(root, file))]),
  );
  assert.deepEqual(checkPublicModules(files), []);
});
