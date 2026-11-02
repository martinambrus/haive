import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTree } from './tree.mjs';

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
