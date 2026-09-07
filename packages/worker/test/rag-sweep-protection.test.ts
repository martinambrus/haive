import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSweepProtectedPaths } from '../src/step-engine/steps/workflow/_rag-index.js';

const exec = promisify(execFile);

const KB = '.haive-data/knowledge_base/ARCHITECTURE.md';
const LEARNING = '.haive-data/learnings/some-lesson.md';

let root: string;
let repo: string;
let worktree: string;

async function write(base: string, rel: string, body: string): Promise<void> {
  const abs = path.join(base, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, 'utf8');
}

async function git(cwd: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'haive-rag-sweep-'));
  repo = path.join(root, 'repo');
  worktree = path.join(root, 'wt');
  await mkdir(repo, { recursive: true });

  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  // A tracked source file plus a tracked learning: both are visible from any worktree.
  await write(repo, 'src/app.php', '<?php echo 1;\n');
  await write(repo, LEARNING, '# lesson\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'initial']);
  // The KB is written by onboarding and never committed — this is the shape that
  // measured 41 deleted chunks in production.
  await write(repo, KB, '# architecture\n');

  await git(repo, ['worktree', 'add', worktree, '-b', 'feature']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveSweepProtectedPaths', () => {
  it('protects the untracked KB a worktree scan cannot see', async () => {
    const protectedPaths = await resolveSweepProtectedPaths(repo, worktree, {});

    expect(protectedPaths.has(KB)).toBe(true);
  });

  it('does not protect tracked paths, so real deletions still propagate', async () => {
    const protectedPaths = await resolveSweepProtectedPaths(repo, worktree, {});

    // Both exist at the repo root, but git carries them into the worktree, so their
    // absence there would be a genuine deletion the sweep must act on.
    expect(protectedPaths.has(LEARNING)).toBe(false);
    expect(protectedPaths.has('src/app.php')).toBe(false);
  });

  it('protects nothing when the scan root IS the repo root', async () => {
    const protectedPaths = await resolveSweepProtectedPaths(repo, repo, {});

    expect(protectedPaths.size).toBe(0);
  });

  it('protects everything found when git cannot answer', async () => {
    const notAGitTree = path.join(root, 'bare');
    await mkdir(notAGitTree, { recursive: true });

    const protectedPaths = await resolveSweepProtectedPaths(repo, notAGitTree, {});

    // Fail closed: unable to tell what the scan root can see, never delete.
    expect(protectedPaths.has(KB)).toBe(true);
    expect(protectedPaths.has(LEARNING)).toBe(true);
  });
});
