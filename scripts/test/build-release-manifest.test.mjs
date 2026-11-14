import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseReleaseManifest } from '../../packages/shared/src/release/manifest.ts';

const env = [{ key: 'LATER_KEY', generate: 'hex', bytes: 16 }];
const first = { 'docker-compose.yml': 'first\r\n', 'docker-compose.gpu.yml': 'gpu\n' };
const second = { 'docker-compose.yml': 'second\n', 'docker-compose.run.yml': 'run\n' };
const current = {
  'docker-compose.yml': 'current\r\n',
  'docker-compose.run.yml': 'current run\n',
  'docker-compose.gpu.yml': 'current gpu\n',
  'docker-compose.vulkan.yml': 'current vulkan\n',
};
const hashes = (files) =>
  Object.fromEntries(
    Object.entries(files).map(([name, body]) => [
      name,
      `sha256:${createHash('sha256').update(body).digest('hex')}`,
    ]),
  );
let root;
let script;
let archivedScript;
let preload;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'mfb-manifest-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'install'));
  mkdirSync(join(root, 'packages/database/migrations'), { recursive: true });
  script = join(root, 'scripts/build-release-manifest.mjs');
  copyFileSync(fileURLToPath(new URL('../build-release-manifest.mjs', import.meta.url)), script);
  writeFileSync(join(root, 'install/bundle-env.json'), JSON.stringify(env));
  writeFileSync(join(root, 'packages/database/migrations/0000_baseline.sql'), 'CREATE TABLE x();');
  writeFileSync(
    join(root, 'packages/database/migrations/0001_added.sql'),
    '-- DROP TABLE is a rollback instruction, not a contract.\nALTER TABLE x ADD y int;\n',
  );
  preload = join(root, 'fixed-clock.mjs');
  // The existing channel publisher archives only the script and migrations, without env metadata.
  mkdirSync(join(root, 'archive/scripts'), { recursive: true });
  archivedScript = join(root, 'archive/scripts/build-release-manifest.mjs');
  copyFileSync(script, archivedScript);
  cpSync(join(root, 'packages'), join(root, 'archive/packages'), { recursive: true });
  writeFileSync(preload, "Date.prototype.toISOString = () => '2026-11-14T00:00:00.000Z';\n");
  const git = (...args) =>
    execFileSync('/usr/bin/git', args, {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'pipe',
    });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Manifest fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('config', 'tag.gpgSign', 'false');
  const commit = () => {
    git('add', '.');
    git('commit', '--no-gpg-sign', '-m', 'bundle fixture');
  };
  const write = (files) => {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body);
  };
  commit();
  git('tag', 'v0.0.0'); // No compose files: omit this record entirely.
  write(first);
  commit();
  git('tag', 'v0.1.0');
  git('tag', 'not-a-release');
  rmSync(join(root, 'docker-compose.gpu.yml'));
  write(second);
  commit();
  git('tag', '-a', 'v0.2.0', '-m', 'annotated release');
  write(current);
  writeFileSync(join(root, 'extra.yml'), 'not in the bundle\n');
  commit();
  git('tag', 'v0.3.0'); // The target itself is not an earlier release.
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function build(args = [], cwd = root, entrypoint = script) {
  return spawnSync(
    process.execPath,
    ['--import', preload, entrypoint, '--version', 'v0.3.0', ...args],
    { cwd, encoding: 'utf8' },
  );
}

test('without --bundle-dir the original manifest bytes are unchanged and need no git or env file', () => {
  // Literal output from the previous generator, with only its clock fixed.
  const result = build(
    ['--api', 'api-image', '--worker', 'worker-image', '--web', 'web-image'],
    tmpdir(),
    archivedScript,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    '{\n' +
      '  "manifestVersion": 1,\n' +
      '  "version": "0.3.0",\n' +
      '  "channel": "public",\n' +
      '  "builtAt": "2026-11-14T00:00:00.000Z",\n' +
      '  "minFrom": "0.0.0",\n' +
      '  "migrationHead": "0001_added",\n' +
      '  "contracts": false,\n' +
      '  "images": {\n' +
      '    "api": "api-image",\n' +
      '    "worker": "worker-image",\n' +
      '    "web": "web-image"\n' +
      '  }\n' +
      '}\n',
  );
});

test('--bundle-dir hashes exact bytes and every earlier release bundle in deterministic order', () => {
  const result = build(['--bundle-dir', root]);
  assert.equal(result.status, 0, result.stderr);
  const manifest = parseReleaseManifest(JSON.parse(result.stdout));
  assert.deepEqual(manifest.bundle, {
    files: hashes(current),
    env,
    known: [hashes(first), hashes(second)],
  });
  assert.equal(build(['--bundle-dir', root]).stdout, result.stdout);
});

test('--bundle-dir hashes only present allowed files', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mfb-partial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'install'));
  writeFileSync(join(dir, 'install/bundle-env.json'), JSON.stringify(env));
  writeFileSync(join(dir, 'docker-compose.run.yml'), second['docker-compose.run.yml']);
  writeFileSync(join(dir, 'ignored.yml'), 'ignored\n');
  const result = build(['--bundle-dir', dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout).bundle.files,
    hashes({
      'docker-compose.run.yml': second['docker-compose.run.yml'],
    }),
  );
});

test('--bundle-dir fails rather than publishing incomplete metadata when git cannot be read', () => {
  const result = build(['--bundle-dir', root], tmpdir());
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

function cloneFixture(t, options = []) {
  const dir = mkdtempSync(join(tmpdir(), 'mfb-clone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('/usr/bin/git', ['clone', ...options, '--no-tags', `file://${root}`, dir], {
    stdio: 'pipe',
  });
  return dir;
}

test('--bundle-dir refuses a shallow checkout even with the first-release opt-out', (t) => {
  const dir = cloneFixture(t, ['--depth', '1']);
  for (const extra of [[], ['--allow-no-history']]) {
    const result = build(['--bundle-dir', dir, ...extra], dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /shallow/i);
  }
});

test('--bundle-dir requires release tags unless explicitly building a first release', (t) => {
  const dir = cloneFixture(t);
  const refused = build(['--bundle-dir', dir], dir);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /no v\* release tags.*--allow-no-history/i);
  const allowed = build(['--bundle-dir', dir, '--allow-no-history'], dir);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.deepEqual(parseReleaseManifest(JSON.parse(allowed.stdout)).bundle.known, []);
});
