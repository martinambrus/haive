import { describe, expect, it } from 'vitest';
import { activeTaskIdFromPath } from '../src/lib/active-task';

describe('activeTaskIdFromPath', () => {
  it('reads the id from a task page', () => {
    expect(activeTaskIdFromPath('/tasks/fe14b042-c2d6-47c0-a3d7-4d1c6bf7ff57')).toBe(
      'fe14b042-c2d6-47c0-a3d7-4d1c6bf7ff57',
    );
  });

  // The sidebar row for a task is still the current one on its sub-pages.
  it('reads the id from a deeper task path', () => {
    expect(activeTaskIdFromPath('/tasks/abc/terminal')).toBe('abc');
  });

  // Nothing is open on the list, so nothing should be marked.
  it('is null on the task list and on other sections', () => {
    expect(activeTaskIdFromPath('/tasks')).toBeNull();
    expect(activeTaskIdFromPath('/tasks/')).toBeNull();
    expect(activeTaskIdFromPath('/repos/abc')).toBeNull();
    expect(activeTaskIdFromPath('/')).toBeNull();
  });

  // `usePathname` yields null before the router resolves.
  it('tolerates a missing pathname', () => {
    expect(activeTaskIdFromPath(null)).toBeNull();
    expect(activeTaskIdFromPath(undefined)).toBeNull();
  });

  it('stops at a query or hash', () => {
    expect(activeTaskIdFromPath('/tasks/abc?tab=1')).toBe('abc');
    expect(activeTaskIdFromPath('/tasks/abc#log')).toBe('abc');
  });
});
