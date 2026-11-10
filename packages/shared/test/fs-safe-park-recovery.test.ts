import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readFileNoFollow,
  rewriteFileIfNoFollow,
  writeFileNoFollow,
  setParkRecoveryOnWrites as configure,
} from '../src/fs-safe.js';
import { logger } from '../src/logger/index.js';

const streamProbe = vi.hoisted(() => ({ entries: 0, measure: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    opendir: async (...args: Parameters<typeof real.opendir>) => {
      const dir = await real.opendir(...args);
      if (!streamProbe.measure) return dir;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const entry of dir) {
            streamProbe.entries += 1;
            yield entry;
          }
        },
      };
    },
  };
});

describe('worker write-path recovery of abandoned parks', () => {
  let root: string;
  let warn: ReturnType<typeof vi.spyOn>;
  const deadPid = 2147483647;
  const park = (leaf: string, pid = deadPid) => `.${leaf}.haive-park-${pid}-${randomUUID()}`;

  const oldClock = () => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
  const sweep = () => writeFileNoFollow(root, 'sweep-trigger', 'write');

  beforeEach(async () => {
    configure(true);
    root = await mkdtemp(path.join(tmpdir(), 'fs-safe-recovery-'));
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    configure(false);
    streamProbe.measure = false;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps a young foreign-pid park even when its content mtime is old', async () => {
    const parked = park('AGENTS.md');
    await writeFile(path.join(root, parked), 'busy');
    const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await utimes(path.join(root, parked), old, old);
    await sweep();
    expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
    expect(await readFile(path.join(root, parked), 'utf8')).toBe('busy');
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([1, process.pid])('restores an old park even with reused pid %s', async (pid) => {
    await writeFile(path.join(root, park('AGENTS.md', pid)), 'abandoned');
    oldClock();
    await sweep();
    expect((await readFileNoFollow(root, 'AGENTS.md'))?.data.toString()).toBe('abandoned');
  });

  it('a read never restores an old park, even in the worker', async () => {
    const parked = park('AGENTS.md');
    await writeFile(path.join(root, parked), 'abandoned');
    oldClock();
    expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
    expect(await readdir(root)).toEqual([parked]);
  });

  it('writes without the worker opt-in never recover parks', async () => {
    configure(false);
    const parked = park('AGENTS.md');
    await writeFile(path.join(root, parked), 'abandoned');
    oldClock();
    await sweep();
    expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
    expect(await readFile(path.join(root, parked), 'utf8')).toBe('abandoned');
  });

  it('warns only once per directory and park across repeated writes', async () => {
    const parked = park('AGENTS.md');
    await writeFile(path.join(root, parked), 'old');
    await writeFile(path.join(root, 'AGENTS.md'), 'new');
    oldClock();
    for (let i = 0; i < 4; i++) await sweep();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('limits park actions to 32 per write and eventually reaches every park', async () => {
    for (let i = 0; i < 75; i++) await writeFile(path.join(root, park('file-' + i)), 'old');
    oldClock();
    const countParks = async () =>
      (await readdir(root)).filter((n) => n.includes('.haive-park-')).length;
    await sweep();
    expect(await countParks()).toBe(43);
    for (let i = 0; i < 6; i++) await sweep();
    expect(await countParks()).toBe(0);
  });

  it('caps a streamed directory slice at 4096 examined entries plus iterator lookahead', async () => {
    await Promise.all(
      Array.from({ length: 4200 }, (_, i) => writeFile(path.join(root, 'entry-' + i), '')),
    );
    streamProbe.entries = 0;
    streamProbe.measure = true;
    await sweep();
    expect(streamProbe.entries).toBe(4097);
  });

  it('reaches old parks beyond the entry window across later writes', async () => {
    await Promise.all(
      Array.from({ length: 8300 }, (_, i) => writeFile(path.join(root, 'entry-' + i), '')),
    );
    const parked = park('AGENTS.md');
    await writeFile(path.join(root, parked), 'old');
    oldClock();
    for (let i = 0; i < 4; i++) await sweep();
    expect((await readFileNoFollow(root, 'AGENTS.md'))?.data.toString()).toBe('old');
  }, 20_000);

  it('restores an old foreign-pid park when its original name is free', async () => {
    await writeFile(path.join(root, park('AGENTS.md')), 'rules');
    oldClock();
    await sweep();
    expect((await readFileNoFollow(root, 'AGENTS.md', { strict: true }))?.data).toEqual(
      Buffer.from('rules'),
    );
    expect(await readdir(root)).toEqual(['AGENTS.md', 'sweep-trigger']);
  });

  it('keeps both files and warns when the original name is taken', async () => {
    const parked = park('AGENTS.md');
    await writeFile(path.join(root, parked), 'old');
    await writeFile(path.join(root, 'AGENTS.md'), 'new');
    oldClock();
    await sweep();
    expect(await readFile(path.join(root, parked), 'utf8')).toBe('old');
    expect(await readFile(path.join(root, 'AGENTS.md'), 'utf8')).toBe('new');
    expect(warn).toHaveBeenCalled();
  });

  it('keeps a young park from this process', async () => {
    const parked = park('AGENTS.md', process.pid);
    await writeFile(path.join(root, parked), 'busy');
    await sweep();
    expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
    expect(await readdir(root)).toEqual([parked, 'sweep-trigger']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a symlink disguised as a park', async () => {
    const parked = park('AGENTS.md');
    await symlink('/etc/passwd', path.join(root, parked));
    oldClock();
    await sweep();
    expect(await readFileNoFollow(root, 'AGENTS.md')).toBeNull();
    expect(await readdir(root)).toEqual([parked, 'sweep-trigger']);
    expect(warn).toHaveBeenCalled();
  });

  it('does not guess the original name of a truncated legacy park', async () => {
    const parked = park('a'.repeat(100));
    await writeFile(path.join(root, parked), 'keep');
    oldClock();
    await sweep();
    expect(await readdir(root)).toEqual([parked, 'sweep-trigger']);
    expect(warn).toHaveBeenCalled();
  });

  it('restores a long name from its recovery-name file', async () => {
    const leaf = 'a'.repeat(251) + '.txt';
    const parked = park(leaf.slice(0, 100));
    await writeFile(path.join(root, parked), 'long rules');
    await writeFile(path.join(root, `${parked}.name`), leaf);
    oldClock();
    await sweep();
    expect((await readFileNoFollow(root, leaf))?.data.toString()).toBe('long rules');
    expect(await readdir(root)).toEqual([leaf, 'sweep-trigger']);
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
    oldClock();
    await sweep();
    expect(await readdir(root)).toHaveLength(3);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses a symlink in place of a recovery-name file', async () => {
    const leaf = 'a'.repeat(101);
    const parked = park(leaf.slice(0, 100));
    await writeFile(path.join(root, parked), 'keep');
    await writeFile(path.join(root, 'name-source'), leaf);
    await symlink('name-source', path.join(root, `${parked}.name`));
    oldClock();
    await sweep();
    expect(await readFileNoFollow(root, leaf)).toBeNull();
    expect(await readFile(path.join(root, parked), 'utf8')).toBe('keep');
    expect(warn).toHaveBeenCalled();
  });

  it('cleans a dead name record left before rename, keeping the public file', async () => {
    const leaf = 'a'.repeat(101);
    const parked = park(leaf.slice(0, 100));
    await writeFile(path.join(root, leaf), 'public');
    await writeFile(path.join(root, `${parked}.name`), leaf);
    oldClock();
    await sweep();
    expect((await readFileNoFollow(root, leaf))?.data.toString()).toBe('public');
    expect(await readdir(root)).toEqual([leaf, 'sweep-trigger']);
  });
});
