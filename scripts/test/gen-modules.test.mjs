import assert from 'node:assert/strict';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { makeTree, names, registry } from './tree.mjs';

const REGISTRIES = [
  'packages/api/src/modules.generated.ts',
  'packages/worker/src/modules.generated.ts',
  'packages/web/src/generated/module-pages.ts',
  'packages/web/src/generated/module-dashboard.ts',
];
const LIST = 'packages/web/src/generated/modules.json';
const WEB = ['./manifest', './routes', './web', './dashboard'];

const generated = (tree) => REGISTRIES.map((rel) => tree.read(rel)).join('\n');

const setSpecs = (tree, specs) => {
  for (const [host, spec] of Object.entries(specs)) {
    const rel = `packages/${host}/package.json`;
    const pkg = JSON.parse(tree.read(rel));
    pkg.dependencies['@haive-module/foo'] = spec;
    writeFileSync(join(tree.root, rel), `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return tree;
};
const specTree = (t, specs, installedVersion = '1.0.0') =>
  setSpecs(
    makeTree(t, {
      installed: { foo: { exports: WEB, version: installedVersion } },
      api: registry('foo'),
      worker: registry('foo'),
      web: registry('foo'),
    }),
    specs,
  );
const INSTALL_MAY_LAG = 'HAIVE_INSTALL_MAY_LAG';
const lagging = (tree) => ({
  ...tree,
  run: (script, args = []) => tree.run(script, args, { [INSTALL_MAY_LAG]: '1' }),
});

describe('gen-modules: installed = depended on by api', () => {
  it('includes a module that api and worker both depend on', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './routes'] } },
      api: names('foo'),
      worker: names('foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(
      tree.read(REGISTRIES[0]),
      /\{ packageName: '@haive\/module-foo', source: 'local', manifest: m0, routes: r0 \},/,
    );
    assert.match(
      tree.read(REGISTRIES[1]),
      /\{ packageName: '@haive\/module-foo', source: 'local', manifest: m0 \},/,
    );
    assert.match(tree.read(REGISTRIES[2]), /moduleWebPages = \{\} as const/);
    assert.doesNotMatch(out.stdout, /not installed/);
  });

  it('includes the web parts of an installed module that web depends on', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: WEB } },
      api: names('foo'),
      worker: names('foo'),
      web: names('foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(tree.read(REGISTRIES[2]), /import w0 from '@haive\/module-foo\/web';/);
    assert.match(tree.read(REGISTRIES[2]), /'foo': w0,/);
    assert.match(tree.read(REGISTRIES[3]), /import d0 from '@haive\/module-foo\/dashboard';/);
    assert.match(tree.read(REGISTRIES[3]), /moduleId: 'foo'/);
  });

  it('maps a ./teardown export to the worker entry beside the other worker parts, and no part a module lacks', (t) => {
    const tree = makeTree(t, {
      modules: {
        bar: { exports: ['./manifest'] },
        foo: { exports: ['./manifest', './steps', './ensure-schema', './jobs', './teardown'] },
      },
      api: names('bar', 'foo'),
      worker: names('bar', 'foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    const worker = tree.read(REGISTRIES[1]);
    assert.match(worker, /^import t1 from '@haive\/module-foo\/teardown';$/m);
    assert.match(
      worker,
      /packageName: '@haive\/module-foo', source: 'local', manifest: m1, steps: s1, ensureSchema: e1, jobs: j1, teardown: t1 \},/,
    );
    assert.match(worker, /packageName: '@haive\/module-bar', source: 'local', manifest: m0 \},/);
    assert.doesNotMatch(tree.read(REGISTRIES[0]), /teardown/);
    assert.doesNotMatch(tree.read(REGISTRIES[2]), /teardown/);
    assert.doesNotMatch(tree.read(REGISTRIES[3]), /teardown/);
  });

  it('maps a ./teardown export on its own', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './teardown'] } },
      api: names('foo'),
      worker: names('foo'),
    });
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    assert.match(
      tree.read(REGISTRIES[1]),
      /\{ packageName: '@haive\/module-foo', source: 'local', manifest: m0, teardown: t0 \},/,
    );
  });

  it('writes empty registries for a tree with no module', (t) => {
    const tree = makeTree(t);
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    for (const rel of REGISTRIES) assert.match(tree.read(rel), /= (\{\}|\[\]) as const;/);
  });

  it('leaves a second run byte-identical', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: WEB } },
      api: names('foo'),
      worker: names('foo'),
      web: names('foo'),
    });
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    const first = tree.snapshot();
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    assert.deepEqual(tree.snapshot(), first);
  });

  it('excludes a module folder nobody depends on, with a notice, and exits 0', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./manifest'] } } });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /present, not installed: pnpm module add foo/);
    assert.doesNotMatch(generated(tree), /module-foo/);
  });

  it('needs no web dependency for an uninstalled module with web parts', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: WEB } } });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /present, not installed: pnpm module add foo/);
    assert.doesNotMatch(generated(tree), /module-foo/);
  });

  it('includes the installed module and excludes the uninstalled one beside it', (t) => {
    const tree = makeTree(t, {
      modules: { bar: { exports: ['./manifest'] }, foo: { exports: ['./manifest'] } },
      api: names('foo'),
      worker: names('foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /present, not installed: pnpm module add bar/);
    assert.doesNotMatch(out.stdout, /pnpm module add foo/);
    assert.match(generated(tree), /module-foo/);
    assert.doesNotMatch(generated(tree), /module-bar/);
  });

  it('ignores a package under modules/ that exports no manifest and no web part', (t) => {
    const tree = makeTree(t, { modules: { helper: { exports: ['./util'] } } });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /not installed/);
  });
});

describe('gen-modules: a half-installed state fails loudly', () => {
  const fails = (tree, ...needles) => {
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 1, `stdout: ${out.stdout}\nstderr: ${out.stderr}`);
    assert.match(out.stderr, /^gen-modules: /, 'a crash also exits 1; the message must be its own');
    for (const needle of needles) assert.ok(out.stderr.includes(needle), out.stderr);
  };

  it('an installed module whose package name is neither form: names both forms', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { name: '@haive/foo', exports: ['./manifest'] } },
      api: ['@haive/foo'],
      worker: ['@haive/foo'],
    });
    fails(tree, '@haive/foo', '@haive/module-<id>', '@haive-module/<id>');
  });

  it('api only: names the worker', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest'] } },
      api: names('foo'),
    });
    fails(tree, '@haive/worker', 'packages/worker/package.json');
  });

  it('worker only: names the api', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest'] } },
      worker: names('foo'),
    });
    fails(tree, '@haive/api', 'packages/api/package.json');
  });

  it('web only: names the api', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: WEB } },
      web: names('foo'),
    });
    fails(tree, '@haive/api', 'packages/api/package.json');
  });

  it('api and web without the worker: names the worker', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: WEB } },
      api: names('foo'),
      web: names('foo'),
    });
    fails(tree, '@haive/worker', 'packages/worker/package.json');
  });

  it('installed module with a web part missing from web: names the web', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: WEB } },
      api: names('foo'),
      worker: names('foo'),
    });
    fails(tree, '@haive/web', 'packages/web/package.json');
  });

  it('web holding an installed module that has no web part: names the web', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './routes'] } },
      api: names('foo'),
      worker: names('foo'),
      web: names('foo'),
    });
    fails(tree, '@haive/web', 'packages/web/package.json');
  });

  it('one half-installed module fails the run even beside a healthy one', (t) => {
    const tree = makeTree(t, {
      modules: { bar: { exports: ['./manifest'] }, foo: { exports: ['./manifest'] } },
      api: names('bar', 'foo'),
      worker: names('foo'),
    });
    fails(tree, '@haive/module-bar', 'packages/worker/package.json');
  });

  it('a web part without a manifest still fails', (t) => {
    const tree = makeTree(t, { modules: { foo: { exports: ['./web'] } } });
    fails(tree, '@haive/module-foo', './manifest');
  });

  it('registry module with a web part missing from web: names the web and the registry package', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: WEB } },
      api: registry('foo'),
      worker: registry('foo'),
    });
    fails(tree, '@haive/web', 'packages/web/package.json', '@haive-module/foo');
  });

  it('registry module held by api without the worker: names the worker', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: ['./manifest'] } },
      api: registry('foo'),
    });
    fails(tree, '@haive/worker', 'packages/worker/package.json', '@haive-module/foo');
  });

  it('registry module held by the worker only: names the api', (t) => {
    const tree = makeTree(t, { worker: registry('foo') });
    fails(tree, '@haive/api', 'packages/api/package.json', '@haive-module/foo');
  });

  it('registry module held by web only: names the api', (t) => {
    const tree = makeTree(t, { web: registry('foo') });
    fails(tree, '@haive/api', 'packages/api/package.json', '@haive-module/foo');
  });

  it('web holding an installed registry module that has no web part: names the web', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: ['./manifest'] } },
      api: registry('foo'),
      worker: registry('foo'),
      web: registry('foo'),
    });
    fails(tree, '@haive/web', 'packages/web/package.json', '@haive-module/foo');
  });

  it('the same id as an installed folder and an installed registry module: names both', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest'] } },
      installed: { foo: { exports: ['./manifest'] } },
      api: [...names('foo'), ...registry('foo')],
      worker: [...names('foo'), ...registry('foo')],
    });
    fails(tree, 'module id "foo"', '@haive/module-foo', '@haive-module/foo');
  });

  it('the same id as a folder nobody depends on and a registry dependency: names both', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest'] } },
      installed: { foo: { exports: ['./manifest'] } },
      api: registry('foo'),
      worker: registry('foo'),
    });
    fails(tree, 'module id "foo"', '@haive/module-foo', '@haive-module/foo');
  });

  it('the same id as a folder and a registry dependency that is not on disk yet: names both', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest'] } },
      api: registry('foo'),
      worker: registry('foo'),
    });
    fails(tree, 'module id "foo"', '@haive/module-foo', '@haive-module/foo');
  });

  it('an installed web-part module not named @haive/module-<id> still fails', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { name: '@haive/foo', exports: WEB } },
      api: ['@haive/foo'],
      worker: ['@haive/foo'],
      web: ['@haive/foo'],
    });
    fails(tree, '@haive/foo', '@haive/module-<id>', '@haive-module/<id>');
  });

  it('registry module only the api depends on, before it is installed: names the worker', (t) => {
    const tree = makeTree(t, { api: registry('foo') });
    fails(tree, '@haive-module/foo', 'packages/worker/package.json');
  });

  it('registry module declared as a range: names the package, the spec, the installed version and the api', (t) => {
    const tree = specTree(t, { api: '^1.0.0', worker: '^1.0.0', web: '^1.0.0' }, '1.2.3');
    fails(tree, '@haive-module/foo', '"^1.0.0"', '"1.2.3"', 'packages/api/package.json');
  });

  it('registry module declared as a range and not on disk yet: says it is not installed', (t) => {
    const tree = setSpecs(makeTree(t, { api: registry('foo'), worker: registry('foo') }), {
      api: '^1.0.0',
      worker: '^1.0.0',
    });
    fails(tree, '@haive-module/foo', '"^1.0.0"', 'not installed');
  });

  it('registry module installed at another version than declared: names the package, both versions and the fix, and generates nothing', (t) => {
    const tree = specTree(t, { api: '1.0.1', worker: '1.0.1', web: '1.0.1' });
    fails(tree, '@haive-module/foo', '"1.0.1"', '"1.0.0"', 'pnpm install');
    for (const rel of [...REGISTRIES, LIST]) assert.equal(tree.has(rel), false, rel);
  });

  it('registry module declared as a range: still refused when the install may lag', (t) => {
    const tree = specTree(t, { api: '^1.0.0', worker: '^1.0.0', web: '^1.0.0' }, '1.2.3');
    fails(lagging(tree), '@haive-module/foo', '"^1.0.0"', '"1.2.3"', 'packages/api/package.json');
  });

  it('registry module at another version in the worker: still refused when the install may lag', (t) => {
    const tree = specTree(t, { worker: '1.0.1' });
    fails(lagging(tree), '@haive-module/foo', '"1.0.0"', '"1.0.1"', 'packages/worker/package.json');
  });

  it('registry module at another version in the worker: names both specs and the worker', (t) => {
    const tree = specTree(t, { worker: '1.0.1' });
    fails(tree, '@haive-module/foo', '"1.0.0"', '"1.0.1"', 'packages/worker/package.json');
  });

  it('registry module at another version in the web: names both specs and the web', (t) => {
    const tree = specTree(t, { web: '1.0.1' });
    fails(tree, '@haive-module/foo', '"1.0.0"', '"1.0.1"', 'packages/web/package.json');
  });
});

describe('gen-modules: registry modules (@haive-module/<id>)', () => {
  it('includes a registry dependency of api and worker, with the source registry', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: ['./manifest', './routes'] } },
      api: registry('foo'),
      worker: registry('foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    const api = tree.read(REGISTRIES[0]);
    assert.match(api, /^import m0 from '@haive-module\/foo\/manifest';$/m);
    assert.match(api, /^import r0 from '@haive-module\/foo\/routes';$/m);
    assert.match(
      api,
      /\{ packageName: '@haive-module\/foo', source: 'registry', manifest: m0, routes: r0 \},/,
    );
    assert.match(
      tree.read(REGISTRIES[1]),
      /\{ packageName: '@haive-module\/foo', source: 'registry', manifest: m0 \},/,
    );
    assert.match(tree.read(REGISTRIES[2]), /moduleWebPages = \{\} as const/);
    assert.doesNotMatch(out.stdout, /not installed/);
  });

  it('includes the web parts of a registry module that web depends on, under its id', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: WEB } },
      api: registry('foo'),
      worker: registry('foo'),
      web: registry('foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(tree.read(REGISTRIES[2]), /import w0 from '@haive-module\/foo\/web';/);
    assert.match(tree.read(REGISTRIES[2]), /'foo': w0,/);
    assert.match(tree.read(REGISTRIES[3]), /import d0 from '@haive-module\/foo\/dashboard';/);
    assert.match(tree.read(REGISTRIES[3]), /moduleId: 'foo'/);
  });

  it('puts a folder module and a registry module of different ids in one registry, each with its source', (t) => {
    const tree = makeTree(t, {
      modules: { bar: { exports: ['./manifest'] } },
      installed: { foo: { exports: ['./manifest'] } },
      api: [...names('bar'), ...registry('foo')],
      worker: [...names('bar'), ...registry('foo')],
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    for (const rel of REGISTRIES.slice(0, 2)) {
      assert.match(tree.read(rel), /packageName: '@haive\/module-bar', source: 'local'/);
      assert.match(tree.read(rel), /packageName: '@haive-module\/foo', source: 'registry'/);
    }
  });

  it('leaves a second run byte-identical', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: WEB } },
      api: registry('foo'),
      worker: registry('foo'),
      web: registry('foo'),
    });
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    assert.match(generated(tree), /@haive-module\/foo/);
    const first = tree.snapshot();
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    assert.deepEqual(tree.snapshot(), first);
  });

  it('leaves out a registry dependency that is not on disk, says so, and exits 0', (t) => {
    const tree = makeTree(t, { api: registry('foo'), worker: registry('foo') });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /@haive-module\/foo/);
    assert.match(out.stdout, /packages\/api\/node_modules\/@haive-module\/foo\/package\.json/);
    assert.doesNotMatch(generated(tree), /haive-module/);
  });

  it('refuses a registry package that exports no manifest, naming the package and the export', (t) => {
    const tree = makeTree(t, {
      installed: { foo: { exports: ['./util'] } },
      api: registry('foo'),
      worker: registry('foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /^gen-modules: @haive-module\/foo .*\.\/manifest/);
  });

  const scopedFolder = (t) =>
    makeTree(t, {
      modules: { foo: { name: '@haive-module/foo', exports: ['./manifest'] } },
      api: registry('foo'),
      worker: registry('foo'),
    });

  it('treats a workspace folder named in the registry scope as a local module, once', (t) => {
    const tree = setSpecs(scopedFolder(t), { api: 'workspace:*', worker: 'workspace:*' });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    const api = tree.read(REGISTRIES[0]);
    assert.equal(api.match(/packageName: '@haive-module\/foo'/g)?.length, 1);
    assert.match(api, /packageName: '@haive-module\/foo', source: 'local'/);
  });

  it('refuses a folder in the registry scope that the hosts pin to a version, naming the fix', (t) => {
    const out = scopedFolder(t).run('gen-modules.mjs');
    assert.equal(out.status, 1, out.stdout);
    for (const part of ['@haive-module/foo', 'modules/foo', '"1.0.0"', '"workspace:*"']) {
      assert.ok(out.stderr.includes(part), out.stderr);
    }
  });

  for (const version of ['1.0.0', '1.0.0-rc.1']) {
    it(`generates the registries from the exact version ${version} in api, worker and web`, (t) => {
      const tree = specTree(t, { api: version, worker: version, web: version }, version);
      const out = tree.run('gen-modules.mjs');
      assert.equal(out.status, 0, out.stderr);
      for (const rel of REGISTRIES.slice(0, 2)) {
        assert.match(tree.read(rel), /packageName: '@haive-module\/foo', source: 'registry'/);
      }
      assert.match(tree.read(REGISTRIES[2]), /import w0 from '@haive-module\/foo\/web';/);
    });
  }

  it('takes a declared version with build metadata as the installed one without it', (t) => {
    const declared = '1.0.0+build.5';
    const tree = specTree(t, { api: declared, worker: declared, web: declared }, '1.0.0');
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
  });

  it('still refuses an installed prerelease that differs from the declared one', (t) => {
    const tree = specTree(
      t,
      { api: '1.0.0-rc.2', worker: '1.0.0-rc.2', web: '1.0.0-rc.2' },
      '1.0.0-rc.1',
    );
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 1);
    assert.ok(out.stderr.includes('"1.0.0-rc.1"'), out.stderr);
  });

  it('generates from the installed copy when the install may lag behind the declared version', (t) => {
    const tree = lagging(specTree(t, { api: '1.1.0', worker: '1.1.0', web: '1.1.0' }));
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    for (const rel of REGISTRIES.slice(0, 2)) {
      assert.match(tree.read(rel), /packageName: '@haive-module\/foo', source: 'registry'/);
    }
  });

  it('uses the exact-version pattern of scripts/module.mjs, character for character', () => {
    const literal = (file, pattern) =>
      pattern.exec(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))?.[1];
    const copy = literal('gen-modules.mjs', /^const EXACT_VERSION = \/(.+)\/;$/m);
    const original = literal('module.mjs', /!\/(.+)\/\.test\(version \?\? ''\)/);
    assert.ok(copy, 'gen-modules.mjs has no EXACT_VERSION literal');
    assert.ok(original, 'module.mjs has no exact-version literal');
    assert.equal(copy, original);
  });
});

describe('gen-modules: the list of web modules compiled in', () => {
  const ALL = {
    modules: {
      abc: { exports: WEB },
      bar: { exports: ['./manifest', './routes'] },
      baz: { exports: WEB },
      mid: { exports: ['./manifest', './dashboard'] },
    },
    installed: { foo: { exports: ['./manifest', './web'] } },
    api: [...names('abc', 'bar', 'mid'), ...registry('foo')],
    worker: [...names('abc', 'bar', 'mid'), ...registry('foo')],
    web: [...names('abc', 'mid'), ...registry('foo')],
  };
  const FOUR = [
    `// Generated by scripts/gen-modules.mjs. Do not edit.
import type { ApiModuleEntry } from './modules/loader.js';
import m0 from '@haive-module/foo/manifest';
import m1 from '@haive/module-abc/manifest';
import r1 from '@haive/module-abc/routes';
import m2 from '@haive/module-bar/manifest';
import r2 from '@haive/module-bar/routes';
import m3 from '@haive/module-mid/manifest';

export const moduleRegistry: readonly ApiModuleEntry[] = [
  { packageName: '@haive-module/foo', source: 'registry', manifest: m0 },
  { packageName: '@haive/module-abc', source: 'local', manifest: m1, routes: r1 },
  { packageName: '@haive/module-bar', source: 'local', manifest: m2, routes: r2 },
  { packageName: '@haive/module-mid', source: 'local', manifest: m3 },
];
`,
    `// Generated by scripts/gen-modules.mjs. Do not edit.
import type { WorkerModuleEntry } from './modules/loader.js';
import m0 from '@haive-module/foo/manifest';
import m1 from '@haive/module-abc/manifest';
import m2 from '@haive/module-bar/manifest';
import m3 from '@haive/module-mid/manifest';

export const moduleRegistry: readonly WorkerModuleEntry[] = [
  { packageName: '@haive-module/foo', source: 'registry', manifest: m0 },
  { packageName: '@haive/module-abc', source: 'local', manifest: m1 },
  { packageName: '@haive/module-bar', source: 'local', manifest: m2 },
  { packageName: '@haive/module-mid', source: 'local', manifest: m3 },
];
`,
    `// Generated by scripts/gen-modules.mjs. Do not edit.
import w0 from '@haive-module/foo/web';
import w1 from '@haive/module-abc/web';

export const moduleWebPages = {
  'foo': w0,
  'abc': w1,
} as const;
`,
    `// Generated by scripts/gen-modules.mjs. Do not edit.
import d0 from '@haive/module-abc/dashboard';
import d1 from '@haive/module-mid/dashboard';

export const moduleDashboardWidgets = [
  ...d0.map((widget) => ({ moduleId: 'abc', ...widget })),
  ...d1.map((widget) => ({ moduleId: 'mid', ...widget })),
] as const;
`,
  ];

  it('lists each module with a web part by id, with its source and parts, and none that is api-only or not installed', (t) => {
    const tree = makeTree(t, ALL);
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /present, not installed: pnpm module add baz/);
    REGISTRIES.forEach((rel, i) => assert.equal(tree.read(rel), FOUR[i], rel));
    const list = [
      { id: 'abc', packageName: '@haive/module-abc', source: 'local', parts: ['dashboard', 'web'] },
      { id: 'foo', packageName: '@haive-module/foo', source: 'registry', parts: ['web'] },
      { id: 'mid', packageName: '@haive/module-mid', source: 'local', parts: ['dashboard'] },
    ];
    assert.equal(tree.read(LIST), `${JSON.stringify(list, null, 2)}\n`);
  });

  it('rewrites none of the five outputs when nothing changed', (t) => {
    const tree = makeTree(t, ALL);
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    const files = [...REGISTRIES, LIST].map((rel) => join(tree.root, rel));
    const past = new Date('2001-01-01T00:00:00Z');
    for (const file of files) utimesSync(file, past, past);
    assert.equal(tree.run('gen-modules.mjs').status, 0);
    for (const file of files) assert.equal(statSync(file).mtimeMs, past.getTime(), file);
  });
});

describe('gen-modules: a tree with no module', () => {
  const EMPTY = [
    '// Generated by scripts/gen-modules.mjs. Do not edit.\nexport const moduleRegistry = [] as const;\n',
    '// Generated by scripts/gen-modules.mjs. Do not edit.\nexport const moduleRegistry = [] as const;\n',
    '// Generated by scripts/gen-modules.mjs. Do not edit.\nexport const moduleWebPages = {} as const;\n',
    '// Generated by scripts/gen-modules.mjs. Do not edit.\nexport const moduleDashboardWidgets = [] as const;\n',
  ];

  it('writes the four registries byte for byte as it did before the registry source', (t) => {
    const tree = makeTree(t);
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    REGISTRIES.forEach((rel, i) => assert.equal(tree.read(rel), EMPTY[i], rel));
    assert.equal(out.stdout, '');
    assert.equal(tree.read(LIST), '[]\n');
  });
});
