import { describe, expect, it } from 'vitest';
import { TERMINAL_SESSION_PREFIX, terminalSessionKey } from '../src/constants/index.js';

describe('terminalSessionKey', () => {
  it('keeps the original task key shape (back-compat with existing sessions)', () => {
    expect(terminalSessionKey('u1', 'task', 't1', 'p1')).toBe(`${TERMINAL_SESSION_PREFIX}u1:t1:p1`);
  });

  it('inserts a repo: infix for repo scope', () => {
    expect(terminalSessionKey('u1', 'repo', 'r1', 'p1')).toBe(
      `${TERMINAL_SESSION_PREFIX}u1:repo:r1:p1`,
    );
  });

  it('task and repo keys for the same ids are distinct', () => {
    // The per-task reaper scans `${PREFIX}*:${taskId}:*`; redis `*` spans
    // colons, so the `repo:` infix is NOT a glob guard. What keeps a repo
    // session out of a task's end-hook sweep is that taskIds and repositoryIds
    // are distinct random UUIDs (no shared id in practice). We assert the keys
    // are at least structurally distinct for the same id.
    const id = 'some-uuid';
    expect(terminalSessionKey('u1', 'task', id, 'p1')).not.toBe(
      terminalSessionKey('u1', 'repo', id, 'p1'),
    );
    expect(terminalSessionKey('u1', 'repo', id, 'p1')).toContain(`:repo:${id}:`);
  });
});
