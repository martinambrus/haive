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
  assert.equal(tree.has('external-modules/.selection.json'), false);
  const local = createRequire(import.meta.url)(join(tree.root, 'scripts/local-modules.cjs'));
  assert.equal(local.localMode(), false);
  const config = { frozenLockfile: true };
  assert.equal(local.updateConfig(config), config);
});

test('remove drops an empty selection while the clone alone keeps local mode active', (t) => {
  const tree = makeTree(t, { modules: { privateone: { exports: ['./manifest'] } } });
  renameSync(join(tree.root, 'modules/privateone'), join(tree.root, 'external-modules/privateone'));
  assert.equal(tree.run('module.mjs', ['add', 'privateone']).status, 0);
  assert.equal(tree.run('module.mjs', ['remove', 'privateone']).status, 0);
  assert.equal(tree.has('external-modules/.selection.json'), false);
  const local = createRequire(import.meta.url)(join(tree.root, 'scripts/local-modules.cjs'));
  assert.equal(local.localMode(), true);
  rmSync(join(tree.root, 'external-modules/privateone'), { recursive: true });
  assert.equal(local.localMode(), false);
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

test('local lock keeps local resolutions until the tracked public lock changes', (t) => {
  const tree = makeTree(t);
  const local = createRequire(import.meta.url)(join(tree.root, 'scripts/local-modules.cjs'));
  mkdirSync(join(tree.root, 'external-modules/privateone'));
  local.updateConfig({});
  const file = join(tree.root, 'external-modules/.lock/pnpm-lock.yaml');
  writeFileSync(file, 'local resolutions\n');
  local.updateConfig({});
  assert.equal(tree.read('external-modules/.lock/pnpm-lock.yaml'), 'local resolutions\n');
  writeFileSync(join(tree.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# changed upstream\n');
  local.updateConfig({});
  assert.equal(tree.read('external-modules/.lock/pnpm-lock.yaml'), tree.read('pnpm-lock.yaml'));
  rmSync(file);
  local.updateConfig({});
  assert.equal(tree.read('external-modules/.lock/pnpm-lock.yaml'), tree.read('pnpm-lock.yaml'));
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

test('root tasks forward every extra argument to Turbo in public and local mode', (t) => {
  const tree = makeTree(t);
  const args = ['--filter=@haive/api', '--force', '--continue', '--', '--reporter=x'];
  for (const mode of ['public', 'local']) {
    if (mode === 'local') mkdirSync(join(tree.root, 'external-modules/privateone'));
    for (const task of ['build', 'test', 'typecheck']) {
      assert.equal(tree.run('workspace-task.mjs', [task, ...args]).status, 0);
      assert.equal(
        tree.pnpmCalls().at(-1),
        `${tree.root} exec turbo run ${task}${mode === 'local' ? ' --force' : ''} ${args.join(' ')}`,
      );
    }
  }
});

test('failed external install restores selection, and a missing selected clone cannot silently disappear', (t) => {
  const tree = makeTree(t, { modules: { privateone: { exports: ['./manifest'] } } });
  renameSync(join(tree.root, 'modules/privateone'), join(tree.root, 'external-modules/privateone'));
  assert.notEqual(tree.run('module.mjs', ['add', 'privateone'], { STUB_PNPM_EXIT: '1' }).status, 0);
  assert.equal(tree.has('external-modules/.selection.json'), false);
  assert.equal(tree.run('module.mjs', ['add', 'privateone']).status, 0);
  rmSync(join(tree.root, 'external-modules/privateone'), { recursive: true });
  const result = tree.run('gen-modules.mjs');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /selected external module.*missing/);
});

test('selected external web parts follow the current clone exports without a selection snapshot', (t) => {
  const tree = makeTree(t, { modules: { privateone: { exports: ['./manifest'] } } });
  renameSync(join(tree.root, 'modules/privateone'), join(tree.root, 'external-modules/privateone'));
  assert.equal(tree.run('module.mjs', ['add', 'privateone']).status, 0);
  assert.equal(
    'web' in JSON.parse(tree.read('external-modules/.selection.json')).privateone,
    false,
  );
  const file = join(tree.root, 'external-modules/privateone/package.json');
  const pkg = JSON.parse(tree.read('external-modules/privateone/package.json'));
  for (const part of ['./web', './dashboard']) {
    pkg.exports[part] = `./dist/${part.slice(2)}.js`;
    writeFileSync(file, JSON.stringify(pkg));
    const result = tree.run('gen-modules.mjs');
    assert.equal(result.status, 0, result.stderr);
    assert.match(tree.read('packages/web/src/generated/modules.json'), new RegExp(part.slice(2)));
    delete pkg.exports[part];
    writeFileSync(file, JSON.stringify(pkg));
    const removed = tree.run('gen-modules.mjs');
    assert.equal(removed.status, 0, removed.stderr);
    assert.doesNotMatch(tree.read('packages/web/src/generated/modules.json'), /privateone/);
  }
});

test('selected external web mismatch advice names module add rather than a tracked manifest edit', (t) => {
  const tree = makeTree(t, {
    modules: { privateone: { exports: ['./manifest'] } },
    web: ['@haive/module-privateone'],
  });
  renameSync(join(tree.root, 'modules/privateone'), join(tree.root, 'external-modules/privateone'));
  const result = tree.run('module.mjs', ['add', 'privateone']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run pnpm module add privateone/);
  assert.doesNotMatch(result.stderr, /from packages\/web\/package.json/);
});
