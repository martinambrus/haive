import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileNoFollow, rewriteFileIfNoFollow } from '../src/fs-safe.js';
import { logger } from '../src/logger/index.js';

describe('recovery on the next operation in a parked file directory', () => {
  let root: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const deadPid = 2147483647;
  const park = (leaf: string, pid = deadPid) => `.${leaf}.haive-park-${pid}-${randomUUID()}`;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-recovery-'));
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('restores a dead process park when its original name is free', async () => {
    await writeFile(path.join(root, park('AGENTS.md')), 'rules');
    expect((await readFileNoFollow(root, 'AGENTS.md', { strict: true }))?.data).toEqual(
      Buffer.from('rules'),
    );
    expect(await readdir(root)).toEqual(['AGENTS.md']);
  });

  it('keeps both files and warns when the original name is taken', async () => {
    const parked = park('AGENTS.md');
    await writeFile(path.join(root, parked), 'old');
    await writeFile(path.join(root, 'AGENTS.md'), 'new');
    await readFileNoFollow(root, 'AGENTS.md');
    expect(await readFile(path.join(root, parked), 'utf8')).toBe('old');
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('new');
    expect(warn).toHaveBeenCalled();
  });

  it('never touches a live process park', async () => {
    const parked = park('AGENTS.md', process.pid);
    await writeFile(path.join(root, parked), 'busy');
    expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
    expect(await readdir(root)).toEqual([parked]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a symlink disguised as a park', async () => {
    const parked = park('AGENTS.md');
    await symlink('/etc/passwd', path.join(root, parked));
    expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
    expect(await readdir(root)).toEqual([parked]);
    expect(warn).toHaveBeenCalled();
  });

  it('does not guess the original name of a truncated legacy park', async () => {
    const parked = park('a'.repeat(100));
    await writeFile(path.join(root, parked), 'keep');
    await readFileNoFollow(root, 'other');
    expect(await readdir(root)).toEqual([parked]);
    expect(warn).toHaveBeenCalled();
  });

  it('restores a long name from its recovery-name file', async () => {
    const leaf = 'a'.repeat(251) + '.txt';
    const parked = park(leaf.slice(0, 100));
    await writeFile(path.join(root, parked), 'long rules');
    await writeFile(path.join(root, `${parked}.name`), leaf);
    expect((await readFileNoFollow(root, leaf))?.data.toString()).toBe('long rules');
    expect(await readdir(root)).toEqual([leaf]);
  });

  it('records the full long name before parking, and cleans the recovery-name file after settling', async () => {
    const leaf = 'é'.repeat(125) + '.txt';
    await writeFile(path.join(root, leaf), 'rules');
    let recorded = false;
    expect(
      await rewriteFileIfNoFollow(root, leaf, async () => {
        const names = await readdir(root);
        const parked = names.find(
          (name) => name.includes('.haive-park-') && !name.endsWith('.name'),
        )!;
        expect(await readFile(path.join(root, `${parked}.name`), 'utf8')).toBe(leaf);
        recorded = true;
        return null;
      }),
    ).toBe('kept');
    expect(recorded).toBe(true);
    expect(await readdir(root)).toEqual([leaf]);
  });

  it('refuses a recovery-name file that names another directory', async () => {
    const parked = park('a'.repeat(100));
    await writeFile(path.join(root, parked), 'keep');
    await writeFile(path.join(root, `${parked}.name`), '../outside');
    await readFileNoFollow(root, 'other');
    expect(await readdir(root)).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses a symlink in place of a recovery-name file', async () => {
    const leaf = 'a'.repeat(101);
    const parked = park(leaf.slice(0, 100));
    await writeFile(path.join(root, parked), 'keep');
    await writeFile(path.join(root, 'name-source'), leaf);
    await symlink('name-source', path.join(root, `${parked}.name`));
    expect(await readFileNoFollow(root, leaf)).toBeNull();
    expect(await readFile(path.join(root, parked), 'utf8')).toBe('keep');
    expect(warn).toHaveBeenCalled();
  });

  it('cleans a dead name record left before rename, keeping the public file', async () => {
    const leaf = 'a'.repeat(101);
    const parked = park(leaf.slice(0, 100));
    await writeFile(path.join(root, leaf), 'public');
    await writeFile(path.join(root, `${parked}.name`), leaf);
    expect((await readFileNoFollow(root, leaf))?.data.toString()).toBe('public');
    expect(await readdir(root)).toEqual([leaf]);
  });
});
