import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HAIVE_DATA_FILES } from '@haive/shared';
import { gitRun } from '../repo/git-push.js';
import { commitPlanSnapshotFiles } from './snapshot-git.js';

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive test',
  GIT_AUTHOR_EMAIL: 'haive-test@example.invalid',
  GIT_COMMITTER_NAME: 'Haive test',
  GIT_COMMITTER_EMAIL: 'haive-test@example.invalid',
};

describe('commitPlanSnapshotFiles', () => {
  const temporaryPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryPaths
        .splice(0)
        .map((temporaryPath) => rm(temporaryPath, { recursive: true, force: true })),
    );
  });

  it('commits both plan files without consuming unrelated staged work', async () => {
    const repoPath = await mkdtemp(path.join(os.tmpdir(), 'plan-snapshot-git-'));
    temporaryPaths.push(repoPath);
    expect((await gitRun(repoPath, ['init', '-b', 'main'])).code).toBe(0);

    const notesPath = path.join(repoPath, 'notes.txt');
    await writeFile(notesPath, 'original notes\n', 'utf8');
    await gitRun(repoPath, ['add', 'notes.txt']);
    expect((await gitRun(repoPath, ['commit', '-m', 'initial'], GIT_IDENTITY)).code).toBe(0);

    await writeFile(notesPath, 'user staged change\n', 'utf8');
    await gitRun(repoPath, ['add', 'notes.txt']);
    await mkdir(path.join(repoPath, '.haive-data'), { recursive: true });
    await writeFile(path.join(repoPath, HAIVE_DATA_FILES.plan), '{"schemaVersion":2}\n', 'utf8');
    await writeFile(
      path.join(repoPath, HAIVE_DATA_FILES.planMarkdown),
      '# Portable plan\n',
      'utf8',
    );

    const result = await commitPlanSnapshotFiles({
      repoPath,
      message: 'docs: save project plan',
      identity: GIT_IDENTITY,
    });
    expect(result.committed).toBe(true);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const committedPlan = await gitRun(repoPath, ['show', `HEAD:${HAIVE_DATA_FILES.plan}`]);
    expect(committedPlan.stdout).toContain('"schemaVersion":2');
    const committedNotes = await gitRun(repoPath, ['show', 'HEAD:notes.txt']);
    expect(committedNotes.stdout).toBe('original notes\n');
    expect(await readFile(notesPath, 'utf8')).toBe('user staged change\n');
    const staged = await gitRun(repoPath, ['diff', '--cached', '--name-only']);
    expect(staged.stdout.trim()).toBe('notes.txt');
  });
});
