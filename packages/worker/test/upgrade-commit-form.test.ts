import { describe, expect, it } from 'vitest';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeCommitStep } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';

const ctx = {} as StepContext;

describe('03-upgrade-commit form', () => {
  it('offers only commit and commitMessage on a repo with history', () => {
    const schema = upgradeCommitStep.form!(ctx, { hasGit: true });
    expect(schema!.fields.map((f) => f.id)).toEqual(['commit', 'commitMessage']);
  });

  it.each([true, false])('T121 commit defaults follow usable origin: %s', (hasOrigin) => {
    const form = upgradeCommitStep.form!(ctx, { hasGit: true, hasOrigin });
    expect(form!.fields.find((f) => f.id === 'commit')).toMatchObject({ default: hasOrigin });
    expect(form!.fields.some((f) => f.id === 'pushToOrigin')).toBe(false);
  });

  // A repo whose onboarding never committed carries no git history; without the init
  // the commit path dies with "fatal: not a git repository".
  it('offers git init when the repo has no history', () => {
    const schema = upgradeCommitStep.form!(ctx, { hasGit: false });
    expect(schema!.fields.map((f) => f.id)).toEqual([
      'noGitNote',
      'commit',
      'initBranch',
      'commitMessage',
    ]);
  });

  // The initial commit holds the whole tree, so the default message must not claim to
  // be only the upgrade.
  it('defaults to an initial-commit message only in the no-git case', () => {
    const withGit = upgradeCommitStep.form!(ctx, { hasGit: true });
    const noGit = upgradeCommitStep.form!(ctx, { hasGit: false });
    const messageOf = (s: typeof withGit): string => {
      const f = s!.fields.find((x) => x.id === 'commitMessage');
      return (f as { default?: string }).default ?? '';
    };
    expect(messageOf(withGit)).toContain('chore: apply Haive onboarding upgrade');
    expect(messageOf(noGit)).toContain('chore: initial commit with Haive onboarding upgrade');
  });
});
