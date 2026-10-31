import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failGit, noGit, type FakeGit } from '../../test/support/fake-git.js';
import {
  mergeCommitted,
  abortMerge,
  abortOtherMerge,
  captureFixBaseline,
  completeMergeHostSide,
  mergeOpenFor,
  openMerge,
  relocateFixerChanges,
  revParse,
  squashMergeCommit,
} from './git-merge.js';

const readFault = vi.hoisted(() => ({ file: '' }));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    readTextNoFollow: async (...args: Parameters<typeof real.readTextNoFollow>) => {
      if (readFault.file && args[1].endsWith(readFault.file))
        throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      return real.readTextNoFollow(...args);
    },
  };
});
const exec = promisify(execFile);
const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: { ...process.env, ...IDENTITY } });
  return stdout.toString();
}
async function gitCode(dir: string, args: string[]): Promise<number> {
  try {
    await git(dir, args);
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}
const sha = async (dir: string, rev = 'HEAD') => (await git(dir, ['rev-parse', rev])).trim();
const mergeIsOpen = async (dir: string) =>
  (await gitCode(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) === 0;
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

const dirs: string[] = [];
afterEach(async () => {
  readFault.file = '';
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 });
});

async function fresh(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gm-unknown-'));
  dirs.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await git(dir, ['config', 'maintenance.auto', 'false']);
  return dir;
}
async function write(dir: string, file: string, body: string): Promise<void> {
  await writeFile(path.join(dir, file), body, 'utf8');
}

/** `main` and `feature/x` both edit `base.txt`, so merging one into the other conflicts. */
async function conflict(): Promise<string> {
  const dir = await fresh();
  await write(dir, 'base.txt', 'base\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'init']);
  await git(dir, ['checkout', '-q', '-b', 'feature/x']);
  await write(dir, 'base.txt', 'feature\n');
  await git(dir, ['commit', '-qam', 'feature']);
  await git(dir, ['checkout', '-q', 'main']);
  await write(dir, 'base.txt', 'main\n');
  await git(dir, ['commit', '-qam', 'main']);
  return dir;
}
async function conflictOpen(): Promise<string> {
  const dir = await conflict();
  await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
  return dir;
}
/** `feature/x` adds two files in two commits; `main` is checked out and has not merged it. */
async function clean(): Promise<string> {
  const dir = await fresh();
  await write(dir, 'base.txt', 'base\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'init']);
  await git(dir, ['checkout', '-q', '-b', 'feature/x']);
  await write(dir, 'one.txt', '1\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'ISS-1: one']);
  await write(dir, 'two.txt', '2\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'ISS-2: two']);
  await git(dir, ['checkout', '-q', 'main']);
  return dir;
}

const MERGE_HEAD = ['rev-parse', '-q', '--verify', 'MERGE_HEAD'];
const HEAD = ['rev-parse', '-q', '--verify', 'HEAD'];
const verify = (spec: string) => ['rev-parse', '-q', '--verify', spec];
const FAILED = /^git rev-parse .+ failed in .+: fatal: simulated failure/;
const gone = () => path.join(tmpdir(), `gm-unknown-not-there-${process.pid}`);

type Failure = { argv: string[]; opts?: { exit?: number; from?: number; until?: number } };

/** Runs `fn` with every listed git read failing, and puts PATH back whatever `fn` does. */
async function whileFailing(failures: Failure[], fn: () => Promise<void>): Promise<void> {
  const shims: FakeGit[] = [];
  try {
    for (const f of failures) shims.push(await failGit(f.argv, f.opts));
    await fn();
  } finally {
    for (const s of shims.reverse()) await s.restore();
  }
}
const failing = (argv: string[], fn: () => Promise<void>, opts?: Failure['opts']) =>
  whileFailing([{ argv, opts }], fn);

describe('D1 revParse: exit 0 is a sha, exit 1 is absent, a missing directory is absent, the rest is a failed read', () => {
  it('D1a exit 0 is the sha and exit 1 is null', async () => {
    const dir = await conflict();
    expect(await revParse(dir, 'HEAD')).toBe(await sha(dir));
    expect(await revParse(dir, 'MERGE_HEAD')).toBeNull();
    expect(await revParse(dir, 'refs/heads/no-such-branch^{commit}')).toBeNull();
  });
  it('D1b exit 128 throws with the spec, the directory and the text git gave', async () => {
    const dir = await conflictOpen();
    await failing(MERGE_HEAD, async () => {
      await expect(revParse(dir, 'MERGE_HEAD')).rejects.toThrow(
        new RegExp(`^git rev-parse MERGE_HEAD failed in ${dir}: fatal: simulated failure`),
      );
    });
  });
  it('D1c a directory that is not there holds no ref, so it reads as absent', async () => {
    expect(await revParse(gone(), 'MERGE_HEAD')).toBeNull();
    expect(await revParse(gone(), 'HEAD')).toBeNull();
  });
  it('D1d a missing git binary in a directory that exists is a failed read, not absent', async () => {
    const dir = await conflictOpen();
    const shim = await noGit();
    try {
      await expect(revParse(dir, 'MERGE_HEAD')).rejects.toThrow(
        /^git rev-parse MERGE_HEAD failed in /,
      );
    } finally {
      await shim.restore();
    }
  });
});

describe('G2 mergeOpenFor', () => {
  it('G2a rejects when MERGE_HEAD cannot be read', async () => {
    const dir = await conflictOpen();
    await failing(MERGE_HEAD, async () => {
      await expect(mergeOpenFor(dir, 'feature/x')).rejects.toThrow(FAILED);
    });
  });
  it('G2b rejects when the ref cannot be read', async () => {
    const dir = await conflictOpen();
    await failing(verify('feature/x^{commit}'), async () => {
      await expect(mergeOpenFor(dir, 'feature/x')).rejects.toThrow(FAILED);
    });
  });
  it('G2c GUARD no merge open is false, and the open merge of the ref is true', async () => {
    expect(await mergeOpenFor(await conflict(), 'feature/x')).toBe(false);
    expect(await mergeOpenFor(await conflictOpen(), 'feature/x')).toBe(true);
  });
  it('G2d GUARD a directory that is not there is false (a cross-branch first pass asks before the base worktree exists)', async () => {
    await expect(mergeOpenFor(gone(), 'feature/x')).resolves.toBe(false);
  });
});

describe('D3 the abort helpers', () => {
  it('G6 abortMerge rejects when MERGE_HEAD cannot be read, and the merge stays open', async () => {
    const dir = await conflictOpen();
    await failing(MERGE_HEAD, async () => {
      await expect(abortMerge(dir)).rejects.toThrow(FAILED);
    });
    expect(await mergeIsOpen(dir)).toBe(true);
  });
  it('G6b GUARD abortMerge on a directory with no merge, or none there, is ok', async () => {
    expect(await abortMerge(await conflict())).toEqual({ ok: true });
    expect(await abortMerge(gone())).toEqual({ ok: true });
  });
  it('G7 a failed `merge --abort` whose MERGE_HEAD re-read also fails is not ok, and says which read', async () => {
    const dir = await conflictOpen();
    let out: Awaited<ReturnType<typeof abortMerge>> | undefined;
    await whileFailing(
      [{ argv: ['merge', '--abort'] }, { argv: MERGE_HEAD, opts: { from: 2 } }],
      async () => {
        out = await abortMerge(dir);
      },
    );
    expect(out).toMatchObject({ ok: false, blocking: [] });
    expect((out as { detail: string }).detail).toMatch(/MERGE_HEAD/);
    expect(await mergeIsOpen(dir)).toBe(true);
  });
  it('G8 abortOtherMerge rejects when MERGE_HEAD cannot be read, and the merge stays open', async () => {
    const dir = await conflictOpen();
    await git(dir, ['branch', 'other', 'main']);
    await failing(MERGE_HEAD, async () => {
      await expect(abortOtherMerge(dir, 'other')).rejects.toThrow(FAILED);
    });
    expect(await mergeIsOpen(dir)).toBe(true);
  });
});

describe('D2 openMerge reads what it needs before git merge runs', () => {
  it('G3 a failed HEAD read (as root, for the hand-back) rejects before the merge runs', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const dir = await conflict();
    const head = await sha(dir);
    await failing(HEAD, async () => {
      await expect(openMerge(dir, 'feature/x', ['--no-edit'], IDENTITY)).rejects.toThrow(FAILED);
    });
    expect(await mergeIsOpen(dir)).toBe(false);
    expect(await sha(dir)).toBe(head);
  });
  it('G5 a failed `<HEAD>^2` read (as root) rejects before the merge runs', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const dir = await conflict();
    const head = await sha(dir);
    await failing(verify(`${head}^2`), async () => {
      await expect(openMerge(dir, 'feature/x', ['--no-edit'], IDENTITY)).rejects.toThrow(FAILED);
    });
    expect(await mergeIsOpen(dir)).toBe(false);
    expect(await sha(dir)).toBe(head);
  });
  it('G5b a failed `<ref>^{commit}` read (as root, HEAD a merge commit) rejects before the merge runs', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const dir = await clean();
    await git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'feature/x']);
    await git(dir, ['checkout', '-q', '-b', 'later', 'feature/x']);
    await write(dir, 'three.txt', '3\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-qm', 'ISS-3: three']);
    await git(dir, ['checkout', '-q', 'main']);
    const head = await sha(dir);
    await failing(verify('later^{commit}'), async () => {
      await expect(openMerge(dir, 'later', ['--no-edit'], IDENTITY)).rejects.toThrow(FAILED);
    });
    expect(await sha(dir)).toBe(head);
  });
  it('G5c a failed ancestry check (as root, HEAD a merge commit) rejects before the merge runs', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const dir = await clean();
    await git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'feature/x']);
    const head = await sha(dir);
    await failing(['merge-base', '--is-ancestor'], async () => {
      await expect(openMerge(dir, 'feature/x', ['--no-edit'], IDENTITY)).rejects.toThrow(
        /merge-base/,
      );
    });
    expect(await sha(dir)).toBe(head);
  });
  it('G4 a failed MERGE_HEAD read after a conflicting merge rejects, the merge stays open, and a healthy abort clears it', async () => {
    const dir = await conflict();
    await failing(MERGE_HEAD, async () => {
      await expect(openMerge(dir, 'feature/x', ['--no-edit'], IDENTITY)).rejects.toThrow(FAILED);
    });
    expect(await mergeIsOpen(dir)).toBe(true);
    expect(await abortMerge(dir)).toEqual({ ok: true });
    expect(await mergeIsOpen(dir)).toBe(false);
  });
  it('G4b GUARD (as root) a ref that does not resolve is refused, not a failed read', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const dir = await clean();
    await git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'feature/x']);
    const out = await openMerge(dir, 'no-such-branch', ['--no-edit'], IDENTITY);
    expect(out.kind).toBe('refused');
  });
  it('G4c GUARD a conflicting merge is still a conflict', async () => {
    const dir = await conflict();
    expect(await openMerge(dir, 'feature/x', ['--no-edit'], IDENTITY)).toEqual({
      kind: 'conflict',
    });
    expect(await mergeIsOpen(dir)).toBe(true);
  });
});

describe('D4 captureFixBaseline', () => {
  it("G9 a failed read is unavailable with git's text; an absent merge keeps its own reason", async () => {
    const dir = await conflictOpen();
    let failed: Awaited<ReturnType<typeof captureFixBaseline>> = null;
    await failing(HEAD, async () => {
      failed = await captureFixBaseline(dir, async () => null);
    });
    expect(failed).toEqual({ unavailable: expect.stringMatching(/fatal: simulated failure/) });
    expect(await captureFixBaseline(await conflict(), async () => null)).toEqual({
      unavailable: 'git could not read the merge',
    });
  });
});

describe('D5 the reads between a merge and its result', () => {
  it('G10 relocateFixerChanges rejects on a failed HEAD read, moves nothing and records nothing', async () => {
    const dir = await conflictOpen();
    const baseline = await captureFixBaseline(dir, async () => null);
    await write(dir, 'stray.txt', 'fixer scratch\n');
    await failing(HEAD, async () => {
      await expect(
        relocateFixerChanges(dir, baseline, { taskId: 't', runId: 'r' }, async () => null),
      ).rejects.toThrow(FAILED);
    });
    expect(await exists(path.join(dir, 'stray.txt'))).toBe(true);
    expect(await exists(path.join(dir, '.haive', 'merge-leftovers'))).toBe(false);
  });
  it('G11 completeMergeHostSide rejects on a failed MERGE_HEAD read, leaves the resolved merge open, and a healthy retry commits', async () => {
    const dir = await conflictOpen();
    await write(dir, 'base.txt', 'resolved\n');
    await failing(MERGE_HEAD, async () => {
      await expect(completeMergeHostSide(dir, IDENTITY, 'feature/x')).rejects.toThrow(FAILED);
    });
    expect(await mergeIsOpen(dir)).toBe(true);
    expect(await completeMergeHostSide(dir, IDENTITY, 'feature/x')).toBe(true);
  });
});

describe('D5 squashMergeCommit', () => {
  async function merged(): Promise<{ dir: string; before: string }> {
    const dir = await clean();
    const before = await sha(dir);
    await git(dir, ['merge', '-q', '--no-ff', '--no-edit', 'feature/x']);
    return { dir, before };
  }

  it('G12 rejects on a failed feature read instead of skipping the squash', async () => {
    const { dir, before } = await merged();
    const head = await sha(dir);
    const skipped: string[] = [];
    await failing(verify('feature/x^{commit}'), async () => {
      await expect(
        squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x', (s) => skipped.push(s)),
      ).rejects.toThrow(FAILED);
    });
    expect(skipped).toEqual([]);
    expect(await sha(dir)).toBe(head);
  });
  it('G13 rejects on a failed `HEAD^2^{commit}` read instead of squashing without the narrowing', async () => {
    const { dir, before } = await merged();
    const head = await sha(dir);
    await failing(verify('HEAD^2^{commit}'), async () => {
      await expect(squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x')).rejects.toThrow(
        FAILED,
      );
    });
    expect(await sha(dir)).toBe(head);
  });
  it('G14 rejects on a failed MERGE_HEAD read before the reset', async () => {
    const { dir, before } = await merged();
    const head = await sha(dir);
    await failing(MERGE_HEAD, async () => {
      await expect(squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x')).rejects.toThrow(
        FAILED,
      );
    });
    expect(await sha(dir)).toBe(head);
  });
  it('G15 rejects on a failed `<merge>^{tree}` read instead of skipping the squash', async () => {
    const { dir, before } = await merged();
    const head = await sha(dir);
    const skipped: string[] = [];
    await failing(verify(`${head}^{tree}`), async () => {
      await expect(
        squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x', (s) => skipped.push(s)),
      ).rejects.toThrow(FAILED);
    });
    expect(skipped).toEqual([]);
    expect(await sha(dir)).toBe(head);
  });
  it('G15b on resume (the reset done) a failed `<merge>^{tree}` read names git, not the staged tree', async () => {
    const { dir, before } = await merged();
    const head = await sha(dir);
    await git(dir, ['reset', '-q', '--soft', before]);
    await failing(verify(`${head}^{tree}`), async () => {
      await expect(squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x')).rejects.toThrow(
        FAILED,
      );
    });
  });
  it('G16 on a retry after a committed squash a failed `HEAD^{tree}` read names git', async () => {
    const { dir, before } = await merged();
    await squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x');
    await failing(verify('HEAD^{tree}'), async () => {
      await expect(squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x')).rejects.toThrow(
        FAILED,
      );
    });
  });
  it('G19 a failed HEAD read after the squash commit rejects, the commit exists, and the retry returns it', async () => {
    const { dir, before } = await merged();
    await failing(
      ['rev-parse', 'HEAD'],
      async () => {
        await expect(squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x')).rejects.toThrow(
          /simulated failure/,
        );
      },
      { from: 2 },
    );
    expect((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');
    expect(await squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x')).toBe(await sha(dir));
  });
  it('G12b GUARD a healthy squash still collapses the merge', async () => {
    const { dir, before } = await merged();
    expect(await squashMergeCommit(dir, before, 'sq', IDENTITY, 'feature/x')).toBe(await sha(dir));
    expect((await git(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');
  });
});

describe('T397 merge completion failures are not an incomplete resolution', () => {
  it.each([
    ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'],
    ['ls-files', '-u'],
    ['add'],
    ['commit'],
  ])('T397 rejects a failed %j without committing', async (...argv) => {
    const dir = await conflictOpen();
    await write(dir, 'base.txt', 'resolved\n');
    const before = await sha(dir);
    await failing(argv, async () => {
      await expect(completeMergeHostSide(dir, IDENTITY, 'feature/x')).rejects.toThrow(
        /git .*failed/,
      );
    });
    expect(await sha(dir)).toBe(before);
    expect(await mergeIsOpen(dir)).toBe(true);
    expect(await completeMergeHostSide(dir, IDENTITY, 'feature/x')).toBe(true);
  });
  it('T397 a failed mergeCommitted status read throws rather than answering false', async () => {
    const dir = await clean();
    await failing(['--no-optional-locks', 'status'], async () => {
      await expect(mergeCommitted(dir, 'feature/x')).rejects.toThrow(/git status.*failed/);
    });
  });
  it('T397 a failed ancestry read throws rather than answering false', async () => {
    const dir = await clean();
    await failing(['merge-base', '--is-ancestor'], async () => {
      await expect(mergeCommitted(dir, 'feature/x')).rejects.toThrow(/git merge-base.*failed/);
    });
  });
});

it.each(['link', 'directory', 'fifo'])(
  'T397 fix4 containment refusal costs one fixer attempt: %s',
  async (kind) => {
    const dir = await conflictOpen();
    const file = path.join(dir, 'base.txt');
    await rm(file);
    if (kind === 'link') await symlink('/unread', file);
    else if (kind === 'directory') await mkdir(file);
    else await exec('mkfifo', [file]);
    await expect(completeMergeHostSide(dir, IDENTITY, 'feature/x')).resolves.toBe(false);
    expect(await mergeIsOpen(dir)).toBe(true);
    await rm(file, { recursive: true, force: true });
    await write(dir, 'base.txt', 'resolved\n');
    expect(await completeMergeHostSide(dir, IDENTITY, 'feature/x')).toBe(true);
  },
);
it('T397 fix4 a genuine IO failure still throws with the merge open', async () => {
  const dir = await conflictOpen();
  await write(dir, 'base.txt', 'resolved\n');
  readFault.file = 'base.txt';
  await expect(completeMergeHostSide(dir, IDENTITY, 'feature/x')).rejects.toThrow('simulated EIO');
  expect(await mergeIsOpen(dir)).toBe(true);
});
it('T397 fix4 a vanished merge directory is not committed', async () => {
  const dir = await conflictOpen();
  await rm(dir, { recursive: true, force: true });
  await expect(mergeCommitted(dir, 'feature/x')).resolves.toBe(false);
});

async function linkedMergeDir() {
  const root = await clean();
  const real = path.join(root, 'real');
  await mkdir(real);
  await mkdir(path.join(root, '.haive'));
  const dir = path.join(real, 'merge');
  await git(root, ['worktree', 'add', '-b', 'linked-base', dir, 'HEAD']);
  await symlink(real, path.join(root, '.haive/worktrees'));
  return path.join(root, '.haive/worktrees/merge');
}
it('T397 D3 a merge directory behind a link is unreadable, not vanished', async () => {
  const dir = await linkedMergeDir();
  await expect(mergeCommitted(dir, 'feature/x')).rejects.toHaveProperty(
    'name',
    'PathContainmentError',
  );
});
it('T397 D7 a failed stat cannot silently skip hand-back before a merge', async () => {
  const asRoot = vi.spyOn(process, 'getuid').mockReturnValue(0);
  try {
    const dir = await linkedMergeDir();
    const before = await sha(dir);
    await expect(openMerge(dir, 'feature/x', ['--no-edit'], IDENTITY)).rejects.toHaveProperty(
      'name',
      'PathContainmentError',
    );
    expect(await sha(dir)).toBe(before);
  } finally {
    asRoot.mockRestore();
  }
});
