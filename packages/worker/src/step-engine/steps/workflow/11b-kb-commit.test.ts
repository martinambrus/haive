import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';
import { hasKbToCommit, kbCommitStep } from './11b-kb-commit.js';
import type { StepContext, StepApplyArgs } from '../../step-definition.js';

const exec = promisify(execFile);

// Deterministic identity for the test repo's setup commits (apply() itself uses
// the FALLBACK identity because the stub db returns no user).
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@haive.local',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@haive.local',
};

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

/** A temp repo with one initial commit, ready for a KB file to be added. */
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kb-commit-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(path.join(dir, 'README.md'), '# repo\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'initial']);
  return dir;
}

// apply() reaches resolveUserGitEnv -> db.query.users.findFirst; returning
// undefined makes it fall back to the built-in identity, so no git config needed.
const stubCtx = {
  logger: { info: () => {} },
  userId: 'u1',
  db: { query: { users: { findFirst: async () => undefined } } },
} as unknown as StepContext;

function applyArgs(
  detected: { hasGit: boolean; workspacePath: string; dirtyFiles: string[]; statusSummary: string },
  formValues: Record<string, unknown>,
): StepApplyArgs<typeof detected> {
  return { detected, formValues, iteration: 0, previousIterations: [] };
}

describe('11b hasKbToCommit (shouldRun gate)', () => {
  it('is true when learnings were written or a LOCAL investigation file was written', () => {
    expect(hasKbToCommit({ written: ['.claude/learnings/x.md'] })).toBe(true);
    expect(
      hasKbToCommit({ investigationWritten: '.claude/knowledge_base/investigations/x.md' }),
    ).toBe(true);
  });

  it('is false when nothing was written or the investigation was promoted to global', () => {
    expect(hasKbToCommit({ written: [], investigationWritten: null })).toBe(false);
    // A global promotion writes NO file, so there is nothing on disk to commit.
    expect(hasKbToCommit({ written: [], investigationWritten: 'global-kb:abc123' })).toBe(false);
    expect(hasKbToCommit(null)).toBe(false);
  });
});

describe('11b form', () => {
  it('defaults the commit checkbox on when KB files are dirty (auto-continue commits)', () => {
    const schema = kbCommitStep.form!(stubCtx, {
      hasGit: true,
      workspacePath: '/ws',
      dirtyFiles: ['.claude/knowledge_base/investigations/x.md'],
      statusSummary: '?? .claude/knowledge_base/investigations/x.md',
    });
    const commit = schema!.fields.find((f) => f.id === 'commit') as { default?: boolean };
    expect(commit.default).toBe(true);
  });

  it('defaults the commit checkbox off when there is nothing to commit', () => {
    const schema = kbCommitStep.form!(stubCtx, {
      hasGit: true,
      workspacePath: '/ws',
      dirtyFiles: [],
      statusSummary: 'No knowledge-base changes pending.',
    });
    const commit = schema!.fields.find((f) => f.id === 'commit') as { default?: boolean };
    expect(commit.default).toBe(false);
  });
});

describe('11b apply', () => {
  it('stages and commits the knowledge-base files in the worktree', async () => {
    const dir = await initRepo();
    try {
      const kbDir = path.join(dir, '.claude', 'knowledge_base', 'investigations');
      await mkdir(kbDir, { recursive: true });
      await writeFile(path.join(kbDir, 'null-deref.md'), '# Null deref\n', 'utf8');

      const out = await kbCommitStep.apply(
        stubCtx,
        applyArgs(
          {
            hasGit: true,
            workspacePath: dir,
            dirtyFiles: ['.claude/knowledge_base/investigations/null-deref.md'],
            statusSummary: '?? .claude/knowledge_base/investigations/null-deref.md',
          },
          { commit: true, commitMessage: 'docs: kb' },
        ),
      );

      expect(out.committed).toBe(true);
      expect(out.commitSha).toBeTruthy();
      // The KB file is in the new commit on the branch.
      const show = await git(dir, ['show', '--stat', '--name-only', 'HEAD']);
      expect(show).toContain('.claude/knowledge_base/investigations/null-deref.md');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not commit when the user unticks commit', async () => {
    const out = await kbCommitStep.apply(
      stubCtx,
      applyArgs(
        { hasGit: true, workspacePath: '/ws', dirtyFiles: ['x'], statusSummary: 'x' },
        { commit: false },
      ),
    );
    expect(out.committed).toBe(false);
  });

  it('is a no-op when there is no git repo', async () => {
    const out = await kbCommitStep.apply(
      stubCtx,
      applyArgs(
        { hasGit: false, workspacePath: '/ws', dirtyFiles: [], statusSummary: '(no git)' },
        { commit: true },
      ),
    );
    expect(out.committed).toBe(false);
  });
});
