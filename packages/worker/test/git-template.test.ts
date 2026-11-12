import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitTemplate } from './support/git-template.js';

describe('git template isolation', () => {
  const build = vi.fn(async (dir: string) => {
    await mkdir(path.join(dir, '.git'));
    await writeFile(path.join(dir, '.git', 'index'), 'initial index');
    await writeFile(path.join(dir, 'tracked'), 'initial content');
    return 'initial sha';
  });
  const template = gitTemplate(build);

  it('builds once while keeping copied files and git metadata independently writable', async () => {
    const first = await template.copy();
    await writeFile(path.join(first.dir, '.git', 'index'), 'changed index');
    await writeFile(path.join(first.dir, 'tracked'), 'changed content');
    const [second, third] = await Promise.all([template.copy(), template.copy()]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(second.data).toBe('initial sha');
    expect(await readFile(path.join(second.dir, '.git', 'index'), 'utf8')).toBe('initial index');
    expect(await readFile(path.join(third.dir, 'tracked'), 'utf8')).toBe('initial content');
    expect((await stat(path.join(first.dir, 'tracked'))).ino).not.toBe(
      (await stat(path.join(second.dir, 'tracked'))).ino,
    );
    expect(first.dir).not.toBe(second.dir);
    expect(second.dir).not.toBe(third.dir);
  });
});
