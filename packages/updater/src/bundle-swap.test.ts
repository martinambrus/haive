import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReleaseManifest } from '@haive/shared/release';
import { bundleHash, stageBundle } from './bundle.js';
import {
  backupBundle,
  pruneBundles,
  readBundleState,
  restoreBundle,
  swapBundle,
} from './bundle-swap.js';
import { setEnvVar } from './run.js';

const names = ['docker-compose.yml', 'docker-compose.run.yml'];
const body = Buffer.from('services: {}\n');
const next = Buffer.from('services: { next: {} }\n');
const files = Object.fromEntries(names.map((name) => [name, bundleHash(next)]));
const target = parseReleaseManifest({
  manifestVersion: 1,
  version: '1.1.0',
  builtAt: '2026-11-14',
  migrationHead: '0221',
  bundle: { files, known: [], env: [] },
});
let dir: string;
let outside: string;
const compose = () => ({ dir, files: [...names] });
const prepare = async () => {
  await stageBundle(compose(), target.bundle!, new Map(names.map((name) => [name, next])));
  return backupBundle(compose(), 'run', target);
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'swap-install-'));
  outside = await mkdtemp(join(tmpdir(), 'swap-outside-'));
  for (const name of names) await writeFile(join(dir, name), body);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

it('copies the replaced owner/mode, uses the install owner for a new record and restores original modes', async () => {
  if (process.getuid?.() === 0) {
    await chown(dir, 65534, 65534);
    await chown(join(dir, names[0]!), 1000, 1000);
  }
  await chmod(join(dir, names[0]!), 0o640);
  const owner = await stat(join(dir, names[0]!));
  const install = await stat(dir);
  const state = await prepare();
  expect(state.from[names[0]!]).toBe(bundleHash(body));
  expect(state.from['.haive-bundle.json']).toBeNull();
  expect(readBundleState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  await swapBundle(compose(), state, target.version);
  const replaced = await stat(join(dir, names[0]!));
  expect([replaced.uid, replaced.gid, replaced.mode]).toEqual([owner.uid, owner.gid, owner.mode]);
  const record = await stat(join(dir, '.haive-bundle.json'));
  expect([record.uid, record.gid, record.mode & 0o777]).toEqual([install.uid, install.gid, 0o644]);
  const backupDir = await stat(join(dir, state.backupDir));
  expect([backupDir.uid, backupDir.gid]).toEqual([install.uid, install.gid]);
  await restoreBundle(compose(), state);
  expect(await readFile(join(dir, names[0]!))).toEqual(body);
  expect((await stat(join(dir, names[0]!))).mode).toBe(owner.mode);
  await expect(readFile(join(dir, '.haive-bundle.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const unchanged = await stat(join(dir, names[0]!));
  await restoreBundle(compose(), state);
  expect((await stat(join(dir, names[0]!))).ino).toBe(unchanged.ino);
});

it('validates every staged file before replacing the first file', async () => {
  const state = await prepare();
  await writeFile(join(dir, '.haive-upgrade/pending/new', names[1]!), 'corrupt');
  await expect(swapBundle(compose(), state, target.version)).rejects.toThrow(
    'staged bundle hash mismatch',
  );
  expect(await readFile(join(dir, names[0]!))).toEqual(body);
});

it('keeps all current files when a later backup hash is wrong', async () => {
  const state = await prepare();
  await swapBundle(compose(), state, target.version);
  await writeFile(join(dir, state.backupDir, names[1]!), 'corrupt');
  await expect(restoreBundle(compose(), state)).rejects.toThrow('backup bundle hash mismatch');
  expect(await readFile(join(dir, names[0]!))).toEqual(next);
});

it.each(['missing', 'corrupt'])('ignores an unneeded %s backup during restore', async (kind) => {
  const state = await prepare();
  if (kind === 'missing') await rm(join(dir, state.backupDir), { recursive: true });
  else await writeFile(join(dir, state.backupDir, names[0]!), 'corrupt');
  await restoreBundle(compose(), state);
  expect(await readFile(join(dir, names[0]!))).toEqual(body);
});

it('validates only backups of files that need restoring', async () => {
  const state = await prepare();
  await writeFile(join(dir, names[0]!), next);
  await rm(join(dir, state.backupDir, names[1]!));
  await restoreBundle(compose(), state);
  for (const name of names) expect(await readFile(join(dir, name))).toEqual(body);
});

it('skips an already swapped file without replacing its inode', async () => {
  const state = await prepare();
  await swapBundle(compose(), state, target.version);
  const before = await stat(join(dir, names[0]!));
  await swapBundle(compose(), state, target.version);
  expect((await stat(join(dir, names[0]!))).ino).toBe(before.ino);
});

it.each(['.haive-upgrade', '.haive-upgrade/pending', '.haive-upgrade/pending/new'])(
  'refuses staging through a linked directory: %s',
  async (part) => {
    const parent = part.split('/').slice(0, -1).join('/');
    if (parent) await mkdir(join(dir, parent), { recursive: true });
    await symlink(outside, join(dir, part));
    await expect(
      stageBundle(compose(), target.bundle!, new Map(names.map((name) => [name, next]))),
    ).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  },
);

it('refuses a linked installed target during swap and rollback', async () => {
  const state = await prepare();
  await writeFile(join(outside, 'untouched'), body);
  await rm(join(dir, names[0]!));
  await symlink(join(outside, 'untouched'), join(dir, names[0]!));
  await expect(swapBundle(compose(), state, target.version)).rejects.toThrow();
  await expect(restoreBundle(compose(), state)).rejects.toThrow();
  expect(await readFile(join(outside, 'untouched'))).toEqual(body);
});

it('refuses a linked backup directory before copying', async () => {
  await mkdir(join(dir, '.haive-upgrade/run'), { recursive: true });
  await symlink(outside, join(dir, '.haive-upgrade/run/previous'));
  await expect(backupBundle(compose(), 'run', target)).rejects.toThrow();
  expect(await readdir(outside)).toEqual([]);
});

it('refuses an env pin write through a link', async () => {
  await writeFile(join(outside, 'env'), 'HAIVE_VERSION=1.0.0\n');
  await symlink(join(outside, 'env'), join(dir, '.env'));
  await expect(setEnvVar(join(dir, '.env'), 'HAIVE_VERSION', '1.1.0')).rejects.toThrow();
  expect(await readFile(join(outside, 'env'), 'utf8')).toBe('HAIVE_VERSION=1.0.0\n');
});

it('prunes older backup and pending/new directories, keeping the newest previous bytes', async () => {
  const state = await prepare();
  await mkdir(join(dir, '.haive-upgrade/older/previous'), { recursive: true });
  await mkdir(join(dir, '.haive-upgrade/run/new'), { recursive: true });
  await pruneBundles(compose(), state);
  expect(await readdir(join(dir, '.haive-upgrade'))).toEqual(['run']);
  expect(await readdir(join(dir, '.haive-upgrade/run'))).toEqual(['previous']);
  expect(await readFile(join(dir, state.backupDir, names[0]!))).toEqual(body);
});

it('rejects incomplete journal hashes and traversal in the journal backup location', async () => {
  const state = await prepare();
  expect(readBundleState(undefined)).toBeUndefined();
  expect(() => readBundleState({ ...state, backupDir: '../elsewhere' })).toThrow('invalid journal');
  expect(() => readBundleState({ ...state, from: {} })).toThrow('invalid journal');
  expect(() => readBundleState({ ...state, to: { ...state.to, unexpected: null } })).toThrow(
    'invalid journal',
  );
});

it('retains an installed overlay omitted by the target so the generated helper still works', async () => {
  await writeFile(join(dir, 'docker-compose.gpu.yml'), body);
  const context = { dir, files: [...names, 'docker-compose.gpu.yml'] };
  const state = await prepare();
  await swapBundle(context, state, target.version);
  expect(context.files).toEqual([...names, 'docker-compose.gpu.yml']);
  expect(await readFile(join(dir, 'docker-compose.gpu.yml'))).toEqual(body);
  await restoreBundle(context, state);
  expect(context.files).toEqual([...names, 'docker-compose.gpu.yml']);
  expect(await readFile(join(dir, 'docker-compose.gpu.yml'))).toEqual(body);
});
