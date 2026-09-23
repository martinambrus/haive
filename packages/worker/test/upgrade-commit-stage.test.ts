import { describe, expect, it } from 'vitest';
import { appliedWrittenPaths } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';

describe('appliedWrittenPaths', () => {
  it('stages the repository paths 02 reports writing', () => {
    expect(
      appliedWrittenPaths({ writtenPaths: ['AGENTS.md', 'CLAUDE.md', '.claude/x.md'] }),
    ).toEqual(['AGENTS.md', 'CLAUDE.md', '.claude/x.md']);
  });

  it('drops anything that is not a path inside the repository', () => {
    expect(
      appliedWrittenPaths({ writtenPaths: ['../escape.md', '/etc/passwd', '', 42, 'AGENTS.md'] }),
    ).toEqual(['AGENTS.md']);
  });

  it('reads nothing from an output persisted before the field existed', () => {
    expect(appliedWrittenPaths({ appliedCount: 1 })).toEqual([]);
    expect(appliedWrittenPaths(null)).toEqual([]);
  });
});
