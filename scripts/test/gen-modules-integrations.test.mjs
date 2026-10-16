import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeTree, names, registry } from './tree.mjs';

const API = 'packages/api/src/modules.generated.ts';
const NOT_THE_API = [
  'packages/worker/src/modules.generated.ts',
  'packages/web/src/generated/module-pages.ts',
  'packages/web/src/generated/module-dashboard.ts',
  'packages/web/src/generated/modules.json',
];

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const importedAs = (api, pkg) =>
  new RegExp(`^import (\\w+) from '${escaped(pkg)}/integrations';$`, 'm').exec(api)?.[1];
const entryOf = (api, pkg) =>
  api.split('\n').find((line) => line.includes(`packageName: '${pkg}'`));
const missing = (pkg, api) =>
  `no default import of ${pkg}/integrations in the api registry:\n${api}`;

describe('gen-modules: a module that exports ./integrations', () => {
  it('[X10] is imported by the api registry and passed to its entry as integrations', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './routes', './integrations'] } },
      api: names('foo'),
      worker: names('foo'),
    });

    const out = tree.run('gen-modules.mjs');

    assert.equal(out.status, 0, out.stderr);
    const api = tree.read(API);
    const ident = importedAs(api, '@haive/module-foo');
    assert.ok(ident, missing('@haive/module-foo', api));
    const entry = entryOf(api, '@haive/module-foo');
    assert.match(entry, new RegExp(`\\bintegrations: ${ident}\\b`), entry);
    assert.match(entry, /\bmanifest: m0\b/, entry);
    assert.match(entry, /\broutes: r0\b/, entry);
  });

  it('[X10] is handled on its own, without ./routes', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './integrations'] } },
      api: names('foo'),
      worker: names('foo'),
    });

    assert.equal(tree.run('gen-modules.mjs').status, 0);
    const api = tree.read(API);
    const ident = importedAs(api, '@haive/module-foo');
    assert.ok(ident, missing('@haive/module-foo', api));
    assert.match(entryOf(api, '@haive/module-foo'), new RegExp(`\\bintegrations: ${ident}\\b`));
    assert.doesNotMatch(api, /\/routes'/);
    assert.doesNotMatch(entryOf(api, '@haive/module-foo'), /\broutes:/);
  });

  it('[X10] is handled for a module installed from the registry the same way', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: ['./manifest', './integrations'] } },
      api: registry('foo'),
      worker: registry('foo'),
    });

    const out = tree.run('gen-modules.mjs');

    assert.equal(out.status, 0, out.stderr);
    const api = tree.read(API);
    const ident = importedAs(api, '@haive-module/foo');
    assert.ok(ident, missing('@haive-module/foo', api));
    assert.match(entryOf(api, '@haive-module/foo'), new RegExp(`\\bintegrations: ${ident}\\b`));
  });

  it('[X10] gives the field to that module alone: its neighbour without the export gets no import and no field', (t) => {
    const tree = makeTree(t, {
      modules: {
        bar: { exports: ['./manifest', './routes'] },
        foo: { exports: ['./manifest', './integrations'] },
      },
      api: names('bar', 'foo'),
      worker: names('bar', 'foo'),
    });

    assert.equal(tree.run('gen-modules.mjs').status, 0);
    const api = tree.read(API);
    const ident = importedAs(api, '@haive/module-foo');
    assert.ok(ident, missing('@haive/module-foo', api));
    assert.match(entryOf(api, '@haive/module-foo'), new RegExp(`\\bintegrations: ${ident}\\b`));
    assert.doesNotMatch(entryOf(api, '@haive/module-bar'), /\bintegrations\b/);
    assert.equal(importedAs(api, '@haive/module-bar'), undefined);
  });

  it('[X10] leaves a second run byte-identical (PIN)', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './routes', './integrations'] } },
      api: names('foo'),
      worker: names('foo'),
    });
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    const first = tree.snapshot();

    assert.equal(tree.run('gen-modules.mjs').status, 0);

    assert.deepEqual(tree.snapshot(), first);
  });

  it('[X10] stays out of the worker and web registries, which cannot see executors (PIN)', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './integrations', './web', './dashboard'] } },
      api: names('foo'),
      worker: names('foo'),
      web: names('foo'),
    });

    assert.equal(tree.run('gen-modules.mjs').status, 0);

    for (const rel of NOT_THE_API) {
      assert.doesNotMatch(tree.read(rel), /integrations/, `${rel} mentions integrations`);
    }
  });

  it('[X10] is not generated for a module that nothing depends on (PIN)', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './integrations'] } },
    });

    const out = tree.run('gen-modules.mjs');

    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(tree.read(API), /integrations|module-foo/);
  });
});

describe('gen-modules: a module that exports no ./integrations', () => {
  it('[X10] gets no import and no integrations field in the api registry (PIN)', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './routes'] } },
      api: names('foo'),
      worker: names('foo'),
    });

    const out = tree.run('gen-modules.mjs');

    assert.equal(out.status, 0, out.stderr);
    const api = tree.read(API);
    assert.doesNotMatch(api, /integrations/);
    assert.match(
      api,
      /\{ packageName: '@haive\/module-foo', source: 'local', manifest: m0, routes: r0 \},/,
    );
  });

  it('[X10] writes the manifest-only entry as before (PIN)', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest'] } },
      api: names('foo'),
      worker: names('foo'),
    });

    assert.equal(tree.run('gen-modules.mjs').status, 0);

    assert.match(
      tree.read(API),
      /\{ packageName: '@haive\/module-foo', source: 'local', manifest: m0 \},/,
    );
  });
});
