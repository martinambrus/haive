import { describe, expect, it } from 'vitest';
import {
  taskMayRunWithoutRepository,
  taskTypeAllowsNoRepository,
  taskWasCreatedRepoLess,
} from '../src/task-scratch.js';

describe('taskTypeAllowsNoRepository', () => {
  it('allows a custom slug, which no built-in name covers', () => {
    expect(taskTypeAllowsNoRepository('my-custom-type')).toBe(true);
    expect(taskTypeAllowsNoRepository('module:some-type')).toBe(true);
  });

  it('keeps the repo-optional built-ins', () => {
    expect(taskTypeAllowsNoRepository('kb_author')).toBe(true);
    expect(taskTypeAllowsNoRepository('type_draft')).toBe(true);
  });

  it('refuses every other built-in', () => {
    for (const type of [
      'workflow',
      'onboarding',
      'run_app',
      'plan_merge',
      'plan_build',
      'plan_chat',
      'plan_sequence',
      'advisory',
      'onboarding_upgrade',
      'env_replicate',
    ]) {
      expect(taskTypeAllowsNoRepository(type), type).toBe(false);
    }
  });
});

describe('taskMayRunWithoutRepository for a custom type', () => {
  it('runs a task created without a repository', () => {
    expect(
      taskMayRunWithoutRepository({
        type: 'my-custom-type',
        metadata: { anchorRepositoryId: null },
      }),
    ).toBe(true);
  });

  it('refuses a task with no recorded anchor, or one anchored to a repository', () => {
    expect(taskMayRunWithoutRepository({ type: 'my-custom-type', metadata: null })).toBe(false);
    expect(taskMayRunWithoutRepository({ type: 'my-custom-type', metadata: {} })).toBe(false);
    expect(
      taskMayRunWithoutRepository({
        type: 'my-custom-type',
        metadata: { anchorRepositoryId: 'r1' },
      }),
    ).toBe(false);
  });

  it('reads the recorded anchor through taskWasCreatedRepoLess', () => {
    expect(taskWasCreatedRepoLess({ anchorRepositoryId: null })).toBe(true);
  });
});
