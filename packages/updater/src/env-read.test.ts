import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureEnvKeys, literalEnvValues } from './envkeys.js';
import { readEnvVar } from './run.js';
import { InstallDirectory } from './install-files.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'updater-env-read-'));
  file = join(dir, '.env');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
  await rm(dir + '-held', { recursive: true, force: true });
});

it('reads the same quoted value as the required-key and display parsers', async () => {
  const value = randomBytes(12).toString('hex');
  const text = `HAIVE_VERSION='${value}' # pin\n`;
  await writeFile(file, text);
  expect(await ensureEnvKeys(file, [{ key: 'HAIVE_VERSION', generate: 'never' }])).toEqual([]);
  expect(await readEnvVar(file, 'HAIVE_VERSION')).toBe(
    literalEnvValues(text, ['HAIVE_VERSION']).HAIVE_VERSION,
  );
  expect(await readEnvVar(file, 'HAIVE_VERSION')).toBe(value);
});

it('ignores assignment-shaped text in multiline quotes and uses the last assignment', async () => {
  await writeFile(
    file,
    'HAIVE_VERSION=old\nOTHER=\'line\nHAIVE_VERSION=hidden\n\'\nexport HAIVE_VERSION = "1.2.3"\n',
  );
  expect(await readEnvVar(file, 'HAIVE_VERSION')).toBe('1.2.3');
});

it('rejects unclosed quotes consistently with required-key parsing', async () => {
  await writeFile(file, "HAIVE_VERSION='broken\n");
  await expect(ensureEnvKeys(file, [{ key: 'HAIVE_VERSION', generate: 'never' }])).rejects.toThrow(
    'syntax',
  );
  await expect(readEnvVar(file, 'HAIVE_VERSION')).rejects.toThrow('syntax');
});

it('distinguishes an absent value from an explicitly empty one', async () => {
  await writeFile(file, 'EMPTY=\n');
  expect(await readEnvVar(file, 'ABSENT')).toBeNull();
  expect(await readEnvVar(file, 'EMPTY')).toBe('');
});

it('refuses a linked env file instead of reading its target', async () => {
  const target = join(dir, 'private');
  await writeFile(target, `HAIVE_VERSION=${randomBytes(12).toString('hex')}\n`);
  await symlink(target, file);
  await expect(readEnvVar(file, 'HAIVE_VERSION')).rejects.toThrow();
});

it('reads through the held directory when its original path is replaced after lstat', async () => {
  await writeFile(file, 'HAIVE_VERSION=1.2.3\n');
  const entry = InstallDirectory.prototype.entry;
  let replaced = false;
  vi.spyOn(InstallDirectory.prototype, 'entry').mockImplementation(async function (
    this: InstallDirectory,
    name,
  ) {
    const result = await entry.call(this, name);
    if (!replaced && name === '.env') {
      replaced = true;
      await rename(dir, dir + '-held');
      await mkdir(dir);
      await writeFile(file, `HAIVE_VERSION=${randomBytes(12).toString('hex')}\n`);
    }
    return result;
  });
  expect(await readEnvVar(file, 'HAIVE_VERSION')).toBe('1.2.3');
  expect(replaced).toBe(true);
});
