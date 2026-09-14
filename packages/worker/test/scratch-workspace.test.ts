import { describe, expect, it } from 'vitest';
import { taskScratchSubpath, taskTypeAllowsNoRepository } from '../src/repo/scratch-workspace.js';

// A null `tasks.repository_id` has TWO meanings — a task deliberately created without one, and
// a task whose repository was deleted out from under it (the column is ON DELETE SET NULL).
// Only the first is a mode; the second must keep failing loudly, which is why this is an
// allowlist rather than a blanket "null is fine".
describe('taskTypeAllowsNoRepository', () => {
  it('allows the KB author, whose article is meant to be repo-independent', () => {
    expect(taskTypeAllowsNoRepository('kb_author')).toBe(true);
  });

  it('refuses every type whose work IS a repository', () => {
    for (const type of ['workflow', 'onboarding', 'run_app', 'plan_build', 'plan_chat']) {
      expect(taskTypeAllowsNoRepository(type)).toBe(false);
    }
  });
});

describe('taskScratchSubpath', () => {
  it('sits under the user directory, where no repository UUID can collide with it', () => {
    expect(taskScratchSubpath('u1', 't1')).toBe('u1/_scratch/t1');
  });

  it('is per task, so two repo-less tasks never share a working directory', () => {
    expect(taskScratchSubpath('u1', 't1')).not.toBe(taskScratchSubpath('u1', 't2'));
  });
});
