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

  it('sanitizes bound errors before inspecting their messages', () => {
    const err = new DrizzleQueryError('select $1', ['/srv/private'], new Error('secret'));
    expect(scrubErrorPaths(err)).toBe('Database operation failed');
  });
});
