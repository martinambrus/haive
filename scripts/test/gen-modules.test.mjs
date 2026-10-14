import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeTree, names } from './tree.mjs';

const REGISTRIES = [
  'packages/api/src/modules.generated.ts',
  'packages/worker/src/modules.generated.ts',
  'packages/web/src/generated/module-pages.ts',
  'packages/web/src/generated/module-dashboard.ts',
];
const WEB = ['./manifest', './routes', './web', './dashboard'];

const generated = (tree) => REGISTRIES.map((rel) => tree.read(rel)).join('\n');

describe('gen-modules: installed = depended on by api', () => {
  it('includes a module that api and worker both depend on', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { exports: ['./manifest', './routes'] } },
      api: names('foo'),
      worker: names('foo'),
    });
    const out = tree.run('gen-modules.mjs');
    assert.equal(out.status, 0, out.stderr);
    assert.match(tree.read(REGISTRIES[0]), /packageName: '@haive\/module-foo'.*routes: r0/);
    assert.match(tree.read(REGISTRIES[1]), /packageName: '@haive\/module-foo'/);
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
      /packageName: '@haive\/module-foo', manifest: m1, steps: s1, ensureSchema: e1, jobs: j1, teardown: t1 \},/,
    );
    assert.match(worker, /packageName: '@haive\/module-bar', manifest: m0 \},/);
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
      /\{ packageName: '@haive\/module-foo', manifest: m0, teardown: t0 \},/,
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

  it('an installed web-part module not named @haive/module-<id> still fails', (t) => {
    const tree = makeTree(t, {
      modules: { foo: { name: '@haive/foo', exports: WEB } },
      api: ['@haive/foo'],
      worker: ['@haive/foo'],
      web: ['@haive/foo'],
    });
    fails(tree, '@haive/foo', '@haive/module-<id>');
  });
});
