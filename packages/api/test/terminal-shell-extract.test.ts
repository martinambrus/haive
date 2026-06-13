import { describe, expect, it } from 'vitest';
import { extractIds, extractRepoIds } from '../src/routes/terminal-shell.js';

const PREFIX = '/terminal-shell/';
const REPO_PREFIX = '/terminal-repo-shell/';

describe('extractIds', () => {
  it('parses taskId/cliProviderId from a clean URL', () => {
    expect(extractIds('/terminal-shell/task-abc/prov-xyz', PREFIX)).toEqual({
      taskId: 'task-abc',
      cliProviderId: 'prov-xyz',
    });
  });

  it('strips query string before parsing', () => {
    expect(extractIds('/terminal-shell/task-1/prov-2?token=foo', PREFIX)).toEqual({
      taskId: 'task-1',
      cliProviderId: 'prov-2',
    });
  });

  it('rejects URLs with the wrong prefix', () => {
    expect(extractIds('/other/task/prov', PREFIX)).toBeNull();
  });

  it('rejects URLs missing the second segment', () => {
    expect(extractIds('/terminal-shell/task-only', PREFIX)).toBeNull();
  });

  it('rejects URLs with extra trailing segments', () => {
    expect(extractIds('/terminal-shell/task/prov/extra', PREFIX)).toBeNull();
  });

  it('rejects empty segments from accidental double-slashes', () => {
    expect(extractIds('/terminal-shell//prov', PREFIX)).toBeNull();
    expect(extractIds('/terminal-shell/task/', PREFIX)).toBeNull();
  });
});

describe('extractRepoIds', () => {
  it('parses repositoryId/cliProviderId from a clean URL', () => {
    expect(extractRepoIds('/terminal-repo-shell/repo-abc/prov-xyz', REPO_PREFIX)).toEqual({
      repositoryId: 'repo-abc',
      cliProviderId: 'prov-xyz',
    });
  });

  it('strips query string before parsing', () => {
    expect(extractRepoIds('/terminal-repo-shell/r1/p2?token=foo', REPO_PREFIX)).toEqual({
      repositoryId: 'r1',
      cliProviderId: 'p2',
    });
  });

  it('rejects the task prefix and other mismatches', () => {
    expect(extractRepoIds('/terminal-shell/r1/p2', REPO_PREFIX)).toBeNull();
    expect(extractRepoIds('/terminal-repo-shell/only', REPO_PREFIX)).toBeNull();
    expect(extractRepoIds('/terminal-repo-shell/r/p/extra', REPO_PREFIX)).toBeNull();
    expect(extractRepoIds('/terminal-repo-shell//p2', REPO_PREFIX)).toBeNull();
  });
});
