import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const h = vi.hoisted(() => ({ removed: [] as string[] }));

vi.mock('../src/repo/worktree-remove.js', () => ({
  removeTaskWorktree: vi.fn(async (_db: unknown, taskId: string) => {
    h.removed.push(taskId);
    return {
      removed: true,
      worktreePath: '/wt',
      method: 'rmdir',
      branch: 'feat',
      branchDeleted: true,
    };
  }),
}));

import { releaseTaskWorktree } from '../src/queues/task-queue.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, env: GIT_ENV });
}

const CUSTOM = ['01-worktree-setup', '07-phase-2-implement', '08c-code-review'];

let wt: string;
let events: string[];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  h.removed.length = 0;
  events = [];
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  wt = await mkdtemp(path.join(tmpdir(), 'wt-release-'));
  await git(wt, ['init', '-b', 'main']);
  await git(wt, ['config', 'gc.auto', '0']);
  await writeFile(path.join(wt, 'f.txt'), 'one\n', 'utf8');
  await git(wt, ['add', '-A']);
  await git(wt, ['commit', '-m', 'one']);
});

afterEach(async () => {
  warn.mockRestore();
  await rm(wt, { recursive: true, force: true });
});

function dbFor(type: string, runListSnapshot: string[] | null, worktreePath = wt): Database {
  return {
    query: {
      tasks: {
        findFirst: async () => ({ type, runListSnapshot, worktreePath }),
      },
    },
    insert: () => ({
      values: async (v: { eventType: string }) => {
        events.push(v.eventType);
      },
    }),
  } as unknown as Database;
}

async function release(
  type: string,
  snapshot: string[] | null,
  reason: 'completed' | 'failed' | 'cancelled' = 'completed',
  worktreePath?: string,
): Promise<boolean> {
  await releaseTaskWorktree(dbFor(type, snapshot, worktreePath), 'task-1', reason);
  return h.removed.length > 0;
}

const dirty = () => writeFile(path.join(wt, 'f.txt'), 'two\n', 'utf8');
const untracked = () => writeFile(path.join(wt, 'new.txt'), 'x\n', 'utf8');

describe('releaseTaskWorktree on completion', () => {
  it('removes the worktree of a custom type that sets one up and never cleans it up', async () => {
    expect(await release('review_only', CUSTOM)).toBe(true);
    expect(events).toEqual(['worktree.removed']);
  });

  it('keeps a custom type’s worktree that holds uncommitted work, and says so', async () => {
    await dirty();
    expect(await release('review_only', CUSTOM)).toBe(false);
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
      expect.any(String),
    );
  });

  it('keeps it for an untracked file too', async () => {
    await untracked();
    expect(await release('review_only', CUSTOM)).toBe(false);
  });

  it('keeps one git cannot read, which is not the same as a clean one', async () => {
    await rm(path.join(wt, '.git'), { recursive: true, force: true });
    await writeFile(path.join(wt, '.git'), 'gitdir: /nonexistent/haive-gitdir\n', 'utf8');
    expect(await release('review_only', CUSTOM)).toBe(false);
    expect(events).toEqual([]);
  });

  it('reaches removal for a worktree directory that is already gone, which holds nothing', async () => {
    const gone = path.join(wt, '.haive', 'worktrees', 'gone');
    expect(await release('review_only', CUSTOM, 'completed', gone)).toBe(true);
    expect(events).toEqual(['worktree.removed']);
  });

  it('leaves a custom type with its own 12-worktree-cleanup to that step', async () => {
    expect(await release('review_only', [...CUSTOM, '12-worktree-cleanup'])).toBe(false);
  });

  it('leaves a custom type with no worktree alone', async () => {
    expect(await release('review_only', ['07-phase-2-implement'])).toBe(false);
    expect(await release('review_only', null)).toBe(false);
  });

  it('keeps removing run_app’s worktree unconditionally, dirty or not', async () => {
    expect(await release('run_app', null)).toBe(true);
    h.removed.length = 0;
    await dirty();
    expect(await release('run_app', CUSTOM)).toBe(true);
  });

  it('never removes a workflow worktree on completion, whatever its list holds', async () => {
    expect(await release('workflow', null)).toBe(false);
    expect(await release('workflow', CUSTOM)).toBe(false);
    expect(await release('workflow', [...CUSTOM, '12-worktree-cleanup'])).toBe(false);
  });
});

describe('releaseTaskWorktree on other endings', () => {
  it('removes on cancel even when dirty, for every type', async () => {
    await dirty();
    expect(await release('workflow', null, 'cancelled')).toBe(true);
    expect(await release('review_only', CUSTOM, 'cancelled')).toBe(true);
  });

  it('keeps everything on failed', async () => {
    expect(await release('run_app', null, 'failed')).toBe(false);
    expect(await release('review_only', CUSTOM, 'failed')).toBe(false);
  });
});
