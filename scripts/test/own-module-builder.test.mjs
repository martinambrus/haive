import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTree } from './tree.mjs';
import { BUILD_CONTEXT_IGNORE } from '../own-module-builder.mjs';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

test('own-module snapshots exclude abandoned fetch staging directories', async (t) => {
  const { snapshotModules } = await import('../own-module-builder.mjs');
  const tree = makeTree(t, { modules: { own: {} } });
  const source = join(tree.root, 'modules');
  mkdirSync(join(source, '.own.tmp-00000000-0000-4000-8000-000000000337'));
  writeFileSync(join(source, 'own', 'value'), 'pinned');
  const output = join(tree.root, 'snapshot');
  snapshotModules(source, output);
  assert.deepEqual(readdirSync(output), ['own']);
  assert.equal(readFileSync(join(output, 'own', 'value'), 'utf8'), 'pinned');
});

test('own-module snapshots wait for an in-progress pin', async (t) => {
  const { snapshotModules } = await import('../own-module-builder.mjs');
  const tree = makeTree(t, { modules: { own: {} } });
  const source = join(tree.root, 'modules');
  const file = join(source, 'own', 'value');
  writeFileSync(file, 'before');
  const locker = spawn('python3', [
    '-c',
    `import fcntl,os,sys,time\nfd=os.open(sys.argv[1],os.O_RDONLY)\nfcntl.flock(fd,fcntl.LOCK_EX)\nprint('ready',flush=True)\ntime.sleep(0.2)\nopen(sys.argv[2],'w').write('after')\nos.close(fd)`,
    source,
    file,
  ]);
  await new Promise((resolve, reject) => {
    locker.stdout.once('data', resolve);
    locker.once('error', reject);
  });
  const output = join(tree.root, 'snapshot');
  snapshotModules(source, output);
  assert.equal(readFileSync(join(output, 'own', 'value'), 'utf8'), 'after');
});

test('prepared own modules retain baked modules and regenerate matching hosts', async (t) => {
  const { prepareModules } = await import('../own-module-builder.mjs');
  const tree = makeTree(t, {
    modules: { baked: {}, own: { exports: ['./manifest', './steps'] } },
    api: ['@haive/module-baked'],
    worker: ['@haive/module-baked'],
  });
  prepareModules(tree.root, ['own'], false);
  for (const host of ['api', 'worker']) {
    const deps = JSON.parse(tree.read(`packages/${host}/package.json`)).dependencies;
    assert.equal(deps['@haive/module-baked'], 'workspace:*');
    assert.equal(deps['@haive/module-own'], 'workspace:*');
  }
  assert.equal(tree.run('gen-modules.mjs').status, 0);
  assert.match(tree.read('packages/api/src/modules.generated.ts'), /module-own\/manifest/);
  assert.match(tree.read('packages/worker/src/modules.generated.ts'), /module-own\/steps/);
});

test('web exports require explicit web rebuild before modifying dependencies', async (t) => {
  const { prepareModules } = await import('../own-module-builder.mjs');
  const tree = makeTree(t, { modules: { own: { exports: ['./manifest', './dashboard'] } } });
  const before = tree.snapshot();
  assert.throws(() => prepareModules(tree.root, ['own'], false), /rebuildWeb/);
  assert.deepEqual(tree.snapshot(), before);
  prepareModules(tree.root, ['own'], true);
  assert.equal(
    JSON.parse(tree.read('packages/web/package.json')).dependencies['@haive/module-own'],
    'workspace:*',
  );
});

test('runtime assembly copies generated artifacts over versioned bases, including web only on request', async () => {
  const { buildDockerfile, parsePlan } = await import('../own-module-builder.mjs');
  const plan = parsePlan({
    version: '1.2.3',
    builderImage: 'fixture-builder:1.2.3',
    baseImages: { api: 'base-api:1.2.3', worker: 'base-worker:1.2.3', web: 'base-web:1.2.3' },
    outputImages: { api: 'local-api:new', worker: 'local-worker:new' },
  });
  const text = buildDockerfile(plan);
  assert.match(text, /FROM base-api:1.2.3 AS api/);
  assert.match(text, /FROM base-worker:1.2.3 AS worker/);
  assert.match(text, /COPY --from=own \/app\/packages\/api\/dist/);
  assert.doesNotMatch(text, /AS web\n/);
  assert.throws(() => parsePlan({ ...plan, rebuildWeb: true }), /outputImages.web/);
});

test('build context excludes fetch pin markers and credentials', () => {
  const entries = BUILD_CONTEXT_IGNORE.split('\n');
  for (const entry of ['**/.haive-source.json', '**/.git', '**/.npmrc', '**/.env']) {
    assert.ok(entries.includes(entry), entry);
  }
});
