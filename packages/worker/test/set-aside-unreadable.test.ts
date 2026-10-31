import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  setAsideHaiveProjections,
  restoreProjectionsInTx,
} from '../src/project-state/set-aside.js';
import { failGit } from './support/fake-git.js';
import type { Database } from '@haive/database';
const exec = promisify(execFile);
it.each(['set-aside', 'final-check'])(
  'T397 unreadable git fails the %s instead of refusing as an open merge',
  async (run) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aside-unreadable-'));
    const db = {
      execute: async () => {},
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as Database;
    try {
      await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      await mkdir(path.join(dir, '.haive-data'));
      await writeFile(path.join(dir, '.haive-data/plan.md'), 'pending\n');
      const shim = await failGit(['rev-parse', '--git-path']);
      try {
        await expect(
          run === 'set-aside'
            ? setAsideHaiveProjections(db, 'r1', dir)
            : restoreProjectionsInTx(db as never, 'r1', dir),
        ).rejects.toMatchObject({ name: 'GitOperationUnreadableError' });
      } finally {
        await shim.restore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
