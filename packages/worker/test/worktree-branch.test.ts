import { describe, expect, it } from 'vitest';
import {
  isBugBranch,
  proposeBranchName,
  slugifyBranch,
  worktreeSetupStep,
} from '../src/step-engine/steps/workflow/01-worktree-setup.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

describe('isBugBranch', () => {
  it('is true when the task is flagged category=bugfix at creation', () => {
    expect(isBugBranch('Add export', null, 'bugfix')).toBe(true);
  });

  it('infers a bug from the title/description when not flagged', () => {
    expect(isBugBranch('Fix login crash', null, null)).toBe(true);
    expect(isBugBranch('Resolve regression in export', null, null)).toBe(true);
    expect(isBugBranch('Page', 'the export button is broken', null)).toBe(true);
  });

  it('treats a plain feature title as not a bug', () => {
    expect(isBugBranch('Add CSV export', 'lets users download data', null)).toBe(false);
  });
});

describe('proposeBranchName', () => {
  it('builds feature/<slug> for a feature', () => {
    expect(proposeBranchName('Add CSV export', false)).toBe('feature/add-csv-export');
  });

  it('builds fix/<slug> for a bug', () => {
    expect(proposeBranchName('Fix login crash', true)).toBe('fix/fix-login-crash');
  });

  it('caps the title slug for conciseness (well under the git ref limit)', () => {
    const out = proposeBranchName('a'.repeat(80), false);
    expect(out.startsWith('feature/')).toBe(true);
    expect(out.length).toBeLessThanOrEqual('feature/'.length + 40);
  });

  it('falls back to "task" when the title has no usable characters', () => {
    expect(proposeBranchName('---', false)).toBe('feature/task');
  });
});

describe('slugifyBranch', () => {
  it('preserves the prefix slash (a flat slugify would lose it)', () => {
    expect(slugifyBranch('feature/My Change')).toBe('feature/my-change');
    expect(slugifyBranch('fix/Login Bug!!')).toBe('fix/login-bug');
  });

  it('drops empty segments and trailing separators', () => {
    expect(slugifyBranch('feature//foo/')).toBe('feature/foo');
  });

  it('falls back when the input is empty after slugifying', () => {
    expect(slugifyBranch('///')).toBe('feature-task');
  });
});

describe('worktreeSetupStep form (base comes from 00a-sync-base)', () => {
  const ctx = {} as unknown as StepContext;
  const baseDetect = {
    hasGit: true as const,
    currentBranch: 'main',
    isClean: true,
    proposedBranch: 'feature/x',
  };

  it('shows the synced base read-only and drops the editable base field', () => {
    const s = worktreeSetupStep.form!(ctx, { ...baseDetect, syncedBase: 'develop' })!;
    expect(s.fields.some((f) => f.id === 'baseBranch')).toBe(false);
    expect(s.fields.some((f) => f.id === 'branchName')).toBe(true);
    expect(s.description).toContain('develop');
  });

  it('falls back to the parent current branch when no synced base was recorded', () => {
    const s = worktreeSetupStep.form!(ctx, { ...baseDetect, syncedBase: null })!;
    expect(s.description).toContain('main');
  });
});
