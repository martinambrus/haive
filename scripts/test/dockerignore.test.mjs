import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const dockerignore = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.dockerignore');

// Build output at the context root and nested one and three levels down, the way a host build of
// a workspace package or a module leaves it. A package's tsbuildinfo sits in its dist.
const OUTPUT = [
  ...['dist', '.next', 'build', '.turbo', 'coverage'].flatMap((dir) => [
    `${dir}/a.txt`,
    `packages/web/${dir}/a.txt`,
    `modules/statistics/src/${dir}/b/a.txt`,
  ]),
  'a.tsbuildinfo',
  'packages/web/a.tsbuildinfo',
  'modules/statistics/src/a.tsbuildinfo',
  'packages/shared/.tsbuildinfo',
];

// Scratch a host run leaves in a package: a tmp directory and logs.
const SCRATCH = ['a.log', 'packages/worker/a.log', 'packages/worker/tmp/a.txt', 'tmp/a.txt'];

// Source whose names only resemble those patterns, and files every image build starts from.
const SOURCE = [
  'package.json',
  'packages/web/package.json',
  'packages/web/src/tsbuildinfo.ts',
  'scripts/build-libs.sh',
  ...[
    'distance',
    'rebuild',
    'builder',
    'coverage-gap',
    '.turbo-notes',
    '.nextcloud',
    'tmpl',
    'log',
  ].map((name) => `packages/web/src/${name}/a.ts`),
  'packages/web/src/changelog.ts',
];

const put = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe('.dockerignore', () => {
  let dir;
  let reached;

  // A FROM scratch build copies whatever the build context let through and exports it, so the
  // exported directory is the context as the daemon received it.
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'haive-dockerignore-'));
    const context = join(dir, 'context');
    for (const file of [...OUTPUT, ...SCRATCH, ...SOURCE]) put(join(context, file), 'x\n');
    put(join(context, '.dockerignore'), readFileSync(dockerignore));
    put(join(dir, 'Dockerfile'), 'FROM scratch\nCOPY . /ctx\n');
    const out = join(dir, 'out');
    const args = ['build', '--output', `type=local,dest=${out}`, '-f', join(dir, 'Dockerfile')];
    const build = spawnSync('docker', [...args, context], { encoding: 'utf8' });
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr);
    const root = join(out, 'ctx');
    reached = new Set(
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')),
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps build output out of the build context at any depth', () => {
    assert.deepEqual(
      OUTPUT.filter((file) => reached.has(file)),
      [],
    );
  });

  it('keeps tmp directories and logs out of the build context at any depth', () => {
    assert.deepEqual(
      SCRATCH.filter((file) => reached.has(file)),
      [],
    );
  });

  it('lets source with a similar name into the build context', () => {
    assert.deepEqual(
      SOURCE.filter((file) => !reached.has(file)),
      [],
    );
  });
});
