import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { makeTree } from './tree.mjs';

test('external add/remove keeps host manifests and canonical lock unchanged, including a deleted clone', (t) => {
  const tree = makeTree(t, {
    modules: { privateone: { name: '@haive-module/privateone', exports: ['./manifest', './web'] } },
  });
  mkdirSync(join(tree.root, 'external-modules'), { recursive: true });
  renameSync(join(tree.root, 'modules/privateone'), join(tree.root, 'external-modules/privateone'));
  const paths = [
    'pnpm-lock.yaml',
    ...['api', 'worker', 'web'].map((host) => `packages/${host}/package.json`),
  ];
  const before = paths.map(tree.read);
  const added = tree.run('module.mjs', ['add', 'privateone']);
  assert.equal(added.status, 0, added.stderr);
  assert.deepEqual(paths.map(tree.read), before);
  assert.match(tree.read('packages/api/src/modules.generated.ts'), /@haive-module\/privateone/);
  assert.match(tree.read('packages/web/src/generated/module-pages.ts'), /privateone/);
  assert.equal(tree.run('module.mjs', ['add', 'privateone']).status, 0);
  rmSync(join(tree.root, 'external-modules/privateone'), { recursive: true });
  const removed = tree.run('module.mjs', ['remove', 'privateone']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.deepEqual(paths.map(tree.read), before);
  assert.doesNotMatch(tree.read('packages/api/src/modules.generated.ts'), /privateone/);
});

test('local lock seeding rebases importers, keeps the normal store, and does not affect public installs', (t) => {
  const tree = makeTree(t);
  const local = createRequire(import.meta.url)(join(tree.root, 'scripts/local-modules.cjs'));
  const original = { frozenLockfile: true };
  assert.equal(local.updateConfig(original), original);
  writeFileSync(
    join(tree.root, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/api:\n    dependencies: {}\npackages:\n  example@1.0.0: {}\n",
  );
  mkdirSync(join(tree.root, 'external-modules/privateone'));
  const config = local.updateConfig(original);
  assert.equal(config.frozenLockfile, false);
  assert.match(tree.read('external-modules/.lock/pnpm-lock.yaml'), /  \.\.\/\.\.\/packages\/api:/);
  assert.match(tree.read('external-modules/.lock/pnpm-lock.yaml'), /packages:\n  example@1.0.0:/);
  assert.equal(config.virtualStoreDir, join(tree.root, 'node_modules/.pnpm'));
  assert.equal(config.lockfileDir, join(tree.root, 'external-modules/.lock'));
});

test('workspace tasks preserve ordinary Turbo behavior, and build local modules before forcing host caches', (t) => {
  const tree = makeTree(t);
  assert.equal(tree.run('workspace-task.mjs', ['build']).status, 0);
  assert.match(tree.pnpmCalls()[0], /exec turbo run build$/);
  mkdirSync(join(tree.root, 'external-modules/privateone'));
  assert.equal(tree.run('workspace-task.mjs', ['typecheck']).status, 0);
  const calls = tree.pnpmCalls();
  assert.match(calls[1], /--filter @haive\/database.*--filter \.\/external-modules\/\* -r build$/);
  assert.match(calls[2], /exec turbo run typecheck --force$/);
});

test('failed external install restores selection, and a missing selected clone cannot silently disappear', (t) => {
  const tree = makeTree(t, { modules: { privateone: { exports: ['./manifest'] } } });
  renameSync(join(tree.root, 'modules/privateone'), join(tree.root, 'external-modules/privateone'));
  assert.notEqual(tree.run('module.mjs', ['add', 'privateone'], { STUB_PNPM_EXIT: '1' }).status, 0);
  assert.deepEqual(JSON.parse(tree.read('external-modules/.selection.json')), {});
  assert.equal(tree.run('module.mjs', ['add', 'privateone']).status, 0);
  rmSync(join(tree.root, 'external-modules/privateone'), { recursive: true });
  const result = tree.run('gen-modules.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /selected external module.*missing/);
});
