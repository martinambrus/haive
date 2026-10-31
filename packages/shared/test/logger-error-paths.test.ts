import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { safeErrorMessage, scrubErrorPaths } from '../src/logger/errors.js';

describe('path scrubbing for displayed error text', () => {
  it.each([
    ["ENOENT: open '/srv/private repo/plan.json'", "ENOENT: open '[path]'"],
    ['git failed in /srv/repo: fatal: bad config', 'git failed in [path]: fatal: bad config'],
    [String.raw`rename 'C:\private repo\a' -> 'D:/private/b'`, "rename '[path]' -> '[path]'"],
    [String.raw`open \\server\share\plan.json failed`, 'open [path] failed'],
    ['open / failed', 'open [path] failed'],
    [
      'git@github.com: Permission denied (publickey)',
      'git@github.com: Permission denied (publickey)',
    ],
    ['ssh://git@host:2222/o/r.git', 'ssh://git@host:2222/o/r.git'],
    ['user@host:/srv/git/r.git', 'user@host:/srv/git/r.git'],
    [
      './a/b ../up/x foo/bar/baz.txt .haive-data/plan.json',
      './a/b ../up/x foo/bar/baz.txt .haive-data/plan.json',
    ],
    ['and/or TCP/IP 10/31/2026', 'and/or TCP/IP 10/31/2026'],
    [
      'git merge could not start: Merge conflict in .haive-data/plan.json',
      'git merge could not start: Merge conflict in .haive-data/plan.json',
    ],
    [
      "git rev-parse --git-path MERGE_HEAD failed in /srv/haive/repos/u/r: fatal: detected dubious ownership in repository at '/srv/haive/repos/u/r'; safe.directory /srv/haive/repos/u/r",
      "git rev-parse --git-path MERGE_HEAD failed in [path]: fatal: detected dubious ownership in repository at '[path]'; safe.directory [path]",
    ],
    [
      "MERGE_HEAD could not be read in /srv/haive/repos/u/r: ELOOP: lstat '/srv/haive/repos/u/r/.git/MERGE_HEAD'",
      "MERGE_HEAD could not be read in [path]: ELOOP: lstat '[path]'",
    ],
    [
      "git remote get-url origin failed in /srv/haive/repos/u/r: error: No such remote 'origin'",
      "git remote get-url origin failed in [path]: error: No such remote 'origin'",
    ],
    [
      "To /srv/haive/repos/u/r-remote.git failed to push some refs to '/srv/haive/repos/u/r-remote.git'",
      "To [path] failed to push some refs to '[path]'",
    ],
    [
      "fatal: '/srv/remotes/r.git' does not appear to be a git repository",
      "fatal: '[path]' does not appear to be a git repository",
    ],
    [
      "rename '/srv/haive/repos/u/r/a.tmp' -> '/srv/haive/repos/u/r/plan.json'",
      "rename '[path]' -> '[path]'",
    ],

    ["open '/srv/a', '/srv/b' failed", "open '[path]', '[path]' failed"],
    ['open (/srv/a) failed', 'open ([path]) failed'],
    ['open `/srv/a b` failed', 'open `[path]` failed'],
    [
      'git failed: https://github.com/o/r.git/: 403',
      'git failed: https://github.com/o/r.git/: 403',
    ],
    [
      'remote ssh://git@host/o/r and file:///srv/repo refused',
      'remote ssh://git@host/o/r and file:///srv/repo refused',
    ],
    ['read /srv/a from https://host/o/r', 'read [path] from https://host/o/r'],
    [
      'Plan snapshot not imported: invalid .haive-data/plan.json',
      'Plan snapshot not imported: invalid .haive-data/plan.json',
    ],
    ['a merge or rebase is open; finish it first', 'a merge or rebase is open; finish it first'],
  ])('scrubs only absolute paths in %s', (raw, expected) => {
    expect(scrubErrorPaths(new Error(raw))).toBe(expected);
    expect(scrubErrorPaths(raw)).toBe(expected);
    expect(scrubErrorPaths(expected)).toBe(expected);
    expect(safeErrorMessage(new Error(raw))).toBe(raw);
  });

  it('scrubs a 200,000-character unbroken token in under two seconds', () => {
    const raw = 'a'.repeat(200_000);
    const start = performance.now();
    const scrubbed = scrubErrorPaths(raw);
    const elapsed = performance.now() - start;
    expect(scrubbed).toBe(raw);
    expect(elapsed).toBeLessThan(2_000);
  }, 120_000);

  it('sanitizes bound errors before inspecting their messages', () => {
    const err = new DrizzleQueryError('select $1', ['/srv/private'], new Error('secret'));
    expect(scrubErrorPaths(err)).toBe('Database operation failed');
  });
});
