import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureEnvKeys } from './envkeys.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rbr-env-'));
  file = join(dir, '.env');
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

it('fills missing, empty, quoted-empty and commented keys, retaining existing values and ownership', async () => {
  const existing = randomBytes(20).toString('hex');
  await writeFile(file, `KEEP=${existing}\nEMPTY= # empty\nQUOTED=""\n# COMMENTED=\n`);
  await chmod(file, 0o640);
  const before = await stat(file);
  const emit = vi.fn();
  const keys = ['MISSING', 'EMPTY', 'QUOTED', 'COMMENTED', 'KEEP'].map((key) => ({
    key,
    generate: 'hex' as const,
    bytes: 24,
  }));
  const added = await ensureEnvKeys(file, keys, { emit });
  expect(added).toEqual(['MISSING', 'EMPTY', 'QUOTED', 'COMMENTED']);
  const text = await readFile(file, 'utf8');
  expect(text).toContain(`KEEP=${existing}\n`);
  for (const key of added) {
    const value = text.match(new RegExp(`^${key}=([a-f0-9]{48})$`, 'm'))![1]!;
    expect(JSON.stringify(emit.mock.calls)).not.toContain(value);
  }
  expect(emit).toHaveBeenCalledExactlyOnceWith('env-added', { envAdded: added });
  const after = await stat(file);
  expect([after.mode, after.uid, after.gid]).toEqual([before.mode, before.uid, before.gid]);
  expect(await ensureEnvKeys(file, keys, { emit })).toEqual([]);
  expect(await readFile(file, 'utf8')).toBe(text);
  expect((await stat(file)).ino).toBe(after.ino);
});

it.each(['', 'REQUIRED=\n', "REQUIRED=''\n", '# REQUIRED=\n'])(
  'refuses a never key before generating or writing anything: %j',
  async (text) => {
    await writeFile(file, text);
    const emit = vi.fn();
    await expect(
      ensureEnvKeys(
        file,
        [
          { key: 'NEW', generate: 'hex', bytes: 16 },
          { key: 'REQUIRED', generate: 'never' },
        ],
        { emit },
      ),
    ).rejects.toMatchObject({ refusal: 'env-key-missing', key: 'REQUIRED' });
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(emit).not.toHaveBeenCalled();
  },
);

it('check detects missing keys but writes and emits nothing', async () => {
  await writeFile(file, '');
  const emit = vi.fn();
  expect(
    await ensureEnvKeys(file, [{ key: 'NEW', generate: 'hex', bytes: 16 }], { check: true, emit }),
  ).toEqual([]);
  expect(await readFile(file, 'utf8')).toBe('');
  expect(emit).not.toHaveBeenCalled();
});

it.each(['plain', 'escaped-quote'])(
  'does not treat assignment-shaped text inside a %s multiline value as an env key',
  async (kind) => {
    const existing = randomBytes(20).toString('hex');
    await writeFile(
      file,
      `OTHER='line${kind === 'escaped-quote' ? "\\'" : ''}\nREQUIRED=${existing}\n'\n`,
    );
    await expect(
      ensureEnvKeys(file, [{ key: 'REQUIRED', generate: 'never' }]),
    ).rejects.toMatchObject({ refusal: 'env-key-missing' });
  },
);

it.each(['regular', 'symlink'])(
  'replaces a leftover %s temp without following it',
  async (kind) => {
    const original = `KEEP=${randomBytes(20).toString('hex')}\n`;
    await writeFile(file, original);
    const temp = `${file}.haive-tmp`;
    const target = join(dir, 'target.env');
    const untouched = randomBytes(24).toString('hex');
    if (kind === 'symlink') {
      await writeFile(target, untouched);
      await symlink(target, temp);
    } else await writeFile(temp, 'incomplete write');
    expect(await ensureEnvKeys(file, [{ key: 'NEW', generate: 'hex', bytes: 16 }])).toEqual([
      'NEW',
    ]);
    const text = await readFile(file, 'utf8');
    expect(text).toMatch(new RegExp(`^${original}NEW=[a-f0-9]{32}\\n$`));
    await expect(stat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
    if (kind === 'symlink') expect(await readFile(target, 'utf8')).toBe(untouched);
  },
);

it.each([
  ['unquoted default', 'REQUIRED=${OTHER:-}\n'],
  ['double-quoted', 'REQUIRED="${OTHER}"\n'],
  ['bare name', 'REQUIRED=$OTHER\n'],
])(
  'refuses a required key whose %s value Compose would interpolate, writing nothing',
  async (_kind, text) => {
    await writeFile(file, text);
    const emit = vi.fn();
    for (const generate of ['hex', 'never'] as const)
      await expect(
        ensureEnvKeys(
          file,
          [
            generate === 'hex'
              ? { key: 'REQUIRED', generate, bytes: 16 }
              : { key: 'REQUIRED', generate },
          ],
          { emit },
        ),
      ).rejects.toMatchObject({ refusal: 'env-key-interpolated', key: 'REQUIRED' });
    expect(await readFile(file, 'utf8')).toBe(text);
    expect(emit).not.toHaveBeenCalled();
  },
);

it.each(["REQUIRED='${OTHER}'\n", 'REQUIRED=a$$b\n'])(
  'accepts a literal value Compose does not interpolate: %j',
  async (text) => {
    await writeFile(file, text);
    expect(await ensureEnvKeys(file, [{ key: 'REQUIRED', generate: 'never' }])).toEqual([]);
  },
);
