import { describe, it, expect } from 'vitest';
import { shouldSyncAuthBack } from './task-auth-volume.js';

// The guard on a write that replaces the user's LOGIN. Pinned here because every wrong
// answer is expensive in a different direction: a false negative leaves the user volume
// holding a consumed token (the rot this sync exists to stop), while a false positive
// overwrites a working login with a dead one.
const OLD = 1_784_736_837_000; // task volume populated, CLI has not written yet
const NEW = 1_785_659_869_000; // something wrote later

describe('shouldSyncAuthBack', () => {
  it('syncs when the in-task CLI rotated the token after the volume was populated', () => {
    expect(shouldSyncAuthBack('fresh-token', 'stale-token', NEW, OLD)).toBe(true);
  });

  it('syncs when the user volume has no readable credential yet', () => {
    expect(shouldSyncAuthBack('fresh-token', null, NEW, null)).toBe(true);
  });

  it('skips when nothing rotated — the CLI never refreshed during this task', () => {
    expect(shouldSyncAuthBack('same-token', 'same-token', NEW, OLD)).toBe(false);
  });

  it('skips an unparseable or empty task credential rather than clobbering the login', () => {
    expect(shouldSyncAuthBack(null, 'working-token', NEW, OLD)).toBe(false);
    expect(shouldSyncAuthBack('', 'working-token', NEW, OLD)).toBe(false);
    expect(shouldSyncAuthBack(null, null, NEW, null)).toBe(false);
  });

  // The regression this guard was rewritten for. A differing token does NOT imply the task
  // copy is newer: a mid-task re-login (or a hand-repaired token) rewrites the USER volume
  // while the task still holds the older copy. Syncing that back would restore the dead
  // token the login just replaced.
  it('skips when the user volume was rewritten mid-task and is newer', () => {
    expect(shouldSyncAuthBack('stale-task-token', 'fresh-login-token', OLD, NEW)).toBe(false);
  });

  it('skips on an mtime tie, which means the file was only ever copied in', () => {
    expect(shouldSyncAuthBack('token-a', 'token-b', OLD, OLD)).toBe(false);
  });

  it('skips when the task mtime is unreadable — no evidence of a later write', () => {
    expect(shouldSyncAuthBack('fresh-token', 'stale-token', null, OLD)).toBe(false);
  });
});
