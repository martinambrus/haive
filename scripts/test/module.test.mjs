import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { describe, it } from 'node:test';
import { makeTree, names, registry } from './tree.mjs';

const HOSTS = ['api', 'worker', 'web'].map((host) => `packages/${host}/package.json`);
const GENERATED = [
  'packages/api/src/modules.generated.ts',
  'packages/worker/src/modules.generated.ts',
  'packages/web/src/generated/module-pages.ts',
  'packages/web/src/generated/module-dashboard.ts',
];
const LINE = '    "@haive/module-foo": "workspace:*",\n';
const APP = ['./manifest', './routes', './web', './dashboard'];

const hosts = (tree) => Object.fromEntries(HOSTS.map((rel) => [rel, tree.read(rel)]));
const dependencies = (tree, rel) => Object.keys(JSON.parse(tree.read(rel)).dependencies);
const installFor = (tree) => `${realpathSync(tree.root)} install --lockfile-only`;
const installed = { api: names('foo'), worker: names('foo'), web: names('foo') };
const REGISTRY_LINE = '    "@haive-module/foo": "1.0.0",\n';
const viewCall = (tree, version = '1.0.0') =>
  `${realpathSync(tree.root)} view @haive-module/foo@${version} exports --json`;
const viewOf = (keys) =>
  JSON.stringify(
    Object.fromEntries(keys.map((key) => [key, { import: `./dist/${key.slice(2)}.js` }])),
  );
const registered = { api: registry('foo'), worker: registry('foo'), web: registry('foo') };

describe('module add', () => {
  it('adds the dependency to api and worker, sorted, and leaves web alone', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./manifest', './routes'] } } });
    const before = hosts(tree);
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS.slice(0, 2)) {
      assert.deepEqual(dependencies(tree, rel), ['@haive/module-foo', '@haive/shared', 'zod']);
      assert.equal(tree.read(rel).replace(LINE, ''), before[rel]);
    }
    assert.equal(tree.read(HOSTS[2]), before[HOSTS[2]]);
    assert.deepEqual(tree.pnpmCalls(), [installFor(tree)]);
    assert.match(tree.read(GENERATED[0]), /packageName: '@haive\/module-foo'/);
    assert.match(tree.read(GENERATED[1]), /packageName: '@haive\/module-foo'/);
    assert.match(out.stdout, /pnpm docker rebuild/);
    assert.match(out.stdout, /Loaded/);
  });

  it('adds the dependency to web too when the module has a web part', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } } });
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS) assert.ok(dependencies(tree, rel).includes('@haive/module-foo'), rel);
    assert.match(tree.read(GENERATED[2]), /'foo': w0,/);
  });

  it('adds it to web for a dashboard widget alone', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./manifest', './dashboard'] } } });
    assert.equal(tree.run('module.mjs', ['add', 'foo']).status, 0);
    assert.ok(dependencies(tree, HOSTS[2]).includes('@haive/module-foo'));
  });

  it('says so and writes nothing when it is a dependency everywhere', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } }, ...installed });
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /already installed/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('completes a half-installed module', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } }, api: names('foo') });
    const before = hosts(tree);
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(tree.read(HOSTS[0]), before[HOSTS[0]]);
    for (const rel of HOSTS.slice(1))
      assert.ok(dependencies(tree, rel).includes('@haive/module-foo'));
  });

  it('drops a web dependency the module has no web part for', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./manifest'] } }, ...installed });
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!dependencies(tree, HOSTS[2]).includes('@haive/module-foo'));
    assert.ok(dependencies(tree, HOSTS[0]).includes('@haive/module-foo'));
  });

  it('refuses a module that has no folder, naming it, and writes nothing', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['add', 'nope']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /modules\/nope\/package\.json not found/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('refuses a package not named @haive/module-<id>', (t) => {
    const tree = makeTree(t, { modules: { foo: { name: '@haive/bar', exports: APP } } });
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /@haive\/module-foo/);
    assert.deepEqual(tree.snapshot(), before);
  });

  it('keeps the edits and fails when a registry dependency already provides the id, naming both', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./manifest'] } }, ...registered });
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.notEqual(out.status, 0);
    assert.ok(out.stderr.includes('@haive/module-foo'), out.stderr);
    assert.ok(out.stderr.includes('@haive-module/foo'), out.stderr);
    assert.ok(dependencies(tree, HOSTS[0]).includes('@haive/module-foo'));
    assert.doesNotMatch(out.stdout, /pnpm docker rebuild/);
  });

  it('refuses a package that exports no manifest', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./web'] } } });
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /\.\/manifest/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('puts the key where the file keeps its order, first, middle and last', (t) => {
    const cases = [
      [{ zod: '^4.6.5' }, ['@haive/module-foo', 'zod']],
      [{ '@haive/a': 'workspace:*', zod: '^4.6.5' }, ['@haive/a', '@haive/module-foo', 'zod']],
      [{ '@haive/a': 'workspace:*' }, ['@haive/a', '@haive/module-foo']],
      [{}, ['@haive/module-foo']],
    ];
    for (const [base, order] of cases) {
      const tree = makeTree(t, { modules: { foo: { exports: ['./manifest'] } }, base });
      const before = hosts(tree);
      assert.equal(tree.run('module.mjs', ['add', 'foo']).status, 0);
      assert.deepEqual(dependencies(tree, HOSTS[0]), order);
      assert.equal(tree.run('module.mjs', ['remove', 'foo']).status, 0);
      assert.deepEqual(hosts(tree), before);
    }
  });

  it('reverts the edits when the lockfile step fails', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } } });
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['add', 'foo'], { STUB_PNPM_EXIT: '1' });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /pnpm install --lockfile-only failed/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), [installFor(tree)]);
  });

  it('keeps the edits and fails when codegen rejects another module', (t) => {
    const tree = makeTree(t, {
      modules: { bar: { exports: ['./manifest'] }, foo: { exports: ['./manifest'] } },
      api: names('bar'),
    });
    const out = tree.run('module.mjs', ['add', 'foo']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /@haive\/module-bar/);
    assert.ok(dependencies(tree, HOSTS[0]).includes('@haive/module-foo'));
    assert.doesNotMatch(out.stdout, /pnpm docker rebuild/);
  });
});

describe('module remove', () => {
  it('removes the dependency everywhere and keeps the module folder', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } }, ...installed });
    const before = hosts(tree);
    const out = tree.run('module.mjs', ['remove', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS) {
      assert.ok(!dependencies(tree, rel).includes('@haive/module-foo'), rel);
      assert.equal(tree.read(rel), before[rel].replace(LINE, ''));
    }
    assert.ok(tree.has('modules/foo/package.json'));
    assert.deepEqual(tree.pnpmCalls(), [installFor(tree)]);
    for (const rel of GENERATED) assert.doesNotMatch(tree.read(rel), /module-foo/);
    assert.match(out.stdout, /present, not installed: pnpm module add foo/);
    assert.match(out.stdout, /pnpm docker rebuild/);
    assert.match(out.stdout, /Missing, with its data kept/);
  });

  it('is undone byte for byte by add', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } }, ...installed });
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    const before = tree.snapshot();
    assert.equal(tree.run('module.mjs', ['remove', 'foo']).status, 0);
    assert.notDeepEqual(tree.snapshot(), before);
    assert.equal(tree.run('module.mjs', ['add', 'foo']).status, 0);
    assert.deepEqual(tree.snapshot(), before);
  });

  it('says so and writes nothing when the folder is present but not installed', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } } });
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['remove', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /not installed/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('refuses an id with no folder and no dependency, and writes nothing', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['remove', 'nope']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /no module "nope"/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('still clears the dependencies when the folder is already gone', (t) => {
    const tree = makeTree(t, installed);
    const out = tree.run('module.mjs', ['remove', 'foo']);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS) assert.ok(!dependencies(tree, rel).includes('@haive/module-foo'));
    assert.deepEqual(tree.pnpmCalls(), [installFor(tree)]);
  });

  it('reverts the edits when the lockfile step fails', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: APP } }, ...installed });
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['remove', 'foo'], { STUB_PNPM_EXIT: '1' });
    assert.notEqual(out.status, 0);
    assert.deepEqual(tree.snapshot(), before);
  });
});

describe('module usage', () => {
  const cases = [[], ['add'], ['remove'], ['frob', 'foo'], ['add', 'foo', 'bar'], ['add', 'Foo']];
  for (const args of cases) {
    it(`rejects "${args.join(' ')}" and writes nothing`, (t) => {
      const tree = makeTree(t, { modules: { foo: { exports: APP } } });
      const before = tree.snapshot();
      const out = tree.run('module.mjs', args);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /usage:|not a module id/);
      assert.deepEqual(tree.snapshot(), before);
      assert.deepEqual(tree.pnpmCalls(), []);
    });
  }

  for (const id of ['../foo', '-x', 'foo/bar', 'foo_bar']) {
    it(`rejects the id "${id}"`, (t) => {
      const tree = makeTree(t, { modules: { foo: { exports: APP } } });
      const before = tree.snapshot();
      const out = tree.run('module.mjs', ['add', id]);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /not a module id/);
      assert.deepEqual(tree.snapshot(), before);
    });
  }
});

describe('module add @haive-module/<id>@<version>', () => {
  const add = (tree, keys, spec = '@haive-module/foo@1.0.0', env = {}) =>
    tree.run('module.mjs', ['add', spec], { STUB_PNPM_VIEW: viewOf(keys), ...env });

  it('adds the version to api and worker, sorted, reads the exports with pnpm view and leaves web alone', (t) => {
    const tree = makeTree(t);
    const before = hosts(tree);
    const out = add(tree, ['./manifest', './routes']);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS.slice(0, 2)) {
      assert.deepEqual(dependencies(tree, rel), ['@haive-module/foo', '@haive/shared', 'zod']);
      assert.equal(tree.read(rel).replace(REGISTRY_LINE, ''), before[rel]);
    }
    assert.equal(tree.read(HOSTS[2]), before[HOSTS[2]]);
    assert.deepEqual(tree.pnpmCalls(), [viewCall(tree), installFor(tree)]);
    assert.match(out.stdout, /pnpm docker rebuild/);
    assert.match(out.stdout, /Loaded/);
  });

  it('adds it to web too when the package exports ./web', (t) => {
    const tree = makeTree(t);
    const out = add(tree, APP);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS) assert.ok(dependencies(tree, rel).includes('@haive-module/foo'), rel);
  });

  it('adds it to web for a dashboard widget alone', (t) => {
    const tree = makeTree(t);
    assert.equal(add(tree, ['./manifest', './dashboard']).status, 0);
    assert.ok(dependencies(tree, HOSTS[2]).includes('@haive-module/foo'));
  });

  it('lets codegen read the package once it is on disk', (t) => {
    const tree = makeTree(t, { installed: { foo: { exports: ['./manifest', './routes'] } } });
    const out = add(tree, ['./manifest', './routes']);
    assert.equal(out.status, 0, out.stderr);
    assert.match(
      tree.read(GENERATED[0]),
      /\{ packageName: '@haive-module\/foo', source: 'registry', manifest: m0, routes: r0 \},/,
    );
  });

  it('says so and writes nothing when that version is a dependency everywhere', (t) => {
    const tree = makeTree(t, registered);
    const before = tree.snapshot();
    const out = add(tree, APP);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /already installed/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), [viewCall(tree)]);
  });

  it('moves the dependency to another version where it stands', (t) => {
    const tree = makeTree(t, registered);
    const before = hosts(tree);
    const out = add(tree, APP, '@haive-module/foo@1.1.0');
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS) {
      assert.equal(
        tree.read(rel),
        before[rel].replace(REGISTRY_LINE, REGISTRY_LINE.replace('1.0.0', '1.1.0')),
      );
    }
    assert.deepEqual(tree.pnpmCalls(), [viewCall(tree, '1.1.0'), installFor(tree)]);
  });

  it('refuses a package whose exports have no ./manifest, naming it, and writes nothing', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = add(tree, ['./web']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /\.\/manifest/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), [viewCall(tree)]);
  });

  it('refuses a registry id longer than a manifest id may be, and writes nothing', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['add', `@haive-module/${'a'.repeat(24)}@1.0.0`]);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /at most 23 characters/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('refuses a package that publishes no exports at all', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['add', '@haive-module/foo@1.0.0']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /\.\/manifest/);
    assert.deepEqual(tree.snapshot(), before);
  });

  it('refuses when pnpm view fails, says so, writes nothing and runs no lockfile step', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = add(tree, APP, '@haive-module/foo@1.0.0', { STUB_PNPM_VIEW_EXIT: '1' });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /pnpm view @haive-module\/foo@1\.0\.0 exports failed/);
    assert.match(out.stderr, /E404/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), [viewCall(tree)]);
  });

  it('reverts the edits when the lockfile step fails', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = add(tree, APP, '@haive-module/foo@1.0.0', { STUB_PNPM_EXIT: '1' });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /pnpm install --lockfile-only failed/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), [viewCall(tree), installFor(tree)]);
  });

  it('keeps the edits and fails when the id is also a folder module, naming both', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./manifest'] } } });
    const out = add(tree, ['./manifest']);
    assert.notEqual(out.status, 0);
    assert.ok(out.stderr.includes('@haive/module-foo'), out.stderr);
    assert.ok(out.stderr.includes('@haive-module/foo'), out.stderr);
    assert.ok(dependencies(tree, HOSTS[0]).includes('@haive-module/foo'));
    assert.doesNotMatch(out.stdout, /pnpm docker rebuild/);
  });

  const versions = ['1.0.0', '10.20.30', '1.0.0-beta.1', '1.0.0+build.5', '1.0.0-rc.1+build.5'];
  for (const version of versions) {
    it(`accepts the exact version ${version}`, (t) => {
      const tree = makeTree(t);
      const out = add(tree, ['./manifest'], `@haive-module/foo@${version}`);
      assert.equal(out.status, 0, out.stderr);
      assert.ok(tree.read(HOSTS[0]).includes(`"@haive-module/foo": "${version}"`));
    });
  }

  const refused = [
    '@haive-module/foo',
    '@haive-module/foo@',
    '@haive-module/foo@latest',
    '@haive-module/foo@^1.0.0',
    '@haive-module/foo@1',
    '@haive-module/foo@1.0',
    '@haive-module/foo@workspace:*',
    '@haive-module/foo@file:../x',
  ];
  for (const spec of refused) {
    it(`refuses "${spec}" for want of an exact version, runs no pnpm and writes nothing`, (t) => {
      const tree = makeTree(t);
      const before = tree.snapshot();
      const out = add(tree, ['./manifest'], spec);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /exact version/);
      assert.deepEqual(tree.snapshot(), before);
      assert.deepEqual(tree.pnpmCalls(), []);
    });
  }

  for (const spec of [
    '@haive-module/Foo@1.0.0',
    '@haive-module/foo/bar@1.0.0',
    '@haive-module/-x@1.0.0',
    '@other/foo@1.0.0',
    '@haive/module-foo@1.0.0',
  ]) {
    it(`rejects the name in "${spec}"`, (t) => {
      const tree = makeTree(t);
      const before = tree.snapshot();
      const out = add(tree, ['./manifest'], spec);
      assert.notEqual(out.status, 0);
      assert.match(out.stderr, /not a module id/);
      assert.deepEqual(tree.snapshot(), before);
      assert.deepEqual(tree.pnpmCalls(), []);
    });
  }
});

describe('module remove @haive-module/<id>', () => {
  it('removes the dependency everywhere, reads nothing from the registry and says the data is kept', (t) => {
    const tree = makeTree(t, registered);
    const before = hosts(tree);
    const out = tree.run('module.mjs', ['remove', '@haive-module/foo']);
    assert.equal(out.status, 0, out.stderr);
    for (const rel of HOSTS) {
      assert.ok(!dependencies(tree, rel).includes('@haive-module/foo'), rel);
      assert.equal(tree.read(rel), before[rel].replace(REGISTRY_LINE, ''));
    }
    assert.deepEqual(tree.pnpmCalls(), [installFor(tree)]);
    assert.match(out.stdout, /Missing, with its data kept/);
    assert.doesNotMatch(out.stdout, /modules\/foo/);
  });

  it('is undone byte for byte by add', (t) => {
    const tree = makeTree(t, registered);
    const before = hosts(tree);
    assert.equal(tree.run('module.mjs', ['remove', '@haive-module/foo']).status, 0);
    assert.notDeepEqual(hosts(tree), before);
    assert.equal(
      tree.run('module.mjs', ['add', '@haive-module/foo@1.0.0'], { STUB_PNPM_VIEW: viewOf(APP) })
        .status,
      0,
    );
    assert.deepEqual(hosts(tree), before);
  });

  it('says so and writes nothing when it is not a dependency anywhere', (t) => {
    const tree = makeTree(t);
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['remove', '@haive-module/foo']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /no module "@haive-module\/foo"/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('refuses a version, since removal is by name', (t) => {
    const tree = makeTree(t, registered);
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['remove', '@haive-module/foo@1.0.0']);
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /without a version/);
    assert.deepEqual(tree.snapshot(), before);
    assert.deepEqual(tree.pnpmCalls(), []);
  });

  it('reverts the edits when the lockfile step fails', (t) => {
    const tree = makeTree(t, registered);
    const before = tree.snapshot();
    const out = tree.run('module.mjs', ['remove', '@haive-module/foo'], { STUB_PNPM_EXIT: '1' });
    assert.notEqual(out.status, 0);
    assert.match(out.stderr, /pnpm install --lockfile-only failed/);
    assert.deepEqual(tree.snapshot(), before);
  });
});
