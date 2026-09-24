import { describe, expect, it } from 'vitest';
import { splitUploadPath } from '../src/repo/worktree-paths.js';

const ROOT = '/var/lib/haive/repos';

describe('splitUploadPath', () => {
  it('splits a path the api wrote into the storage root and the rel below it', () => {
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/u1/db-abc.sql`)).toEqual({
      anchor: ROOT,
      rel: '_uploads/u1/db-abc.sql',
    });
  });

  it('accepts a storage root configured with a trailing slash', () => {
    // The api joins with path.join, so it stores the path without the doubled separator.
    expect(splitUploadPath(`${ROOT}/`, `${ROOT}/_uploads/u1/repo.zip`)).toEqual({
      anchor: `${ROOT}/`,
      rel: '_uploads/u1/repo.zip',
    });
  });

  it('refuses a path outside the uploads directory', () => {
    // A repository tree, not an upload — the caller must not delete or read through this helper.
    expect(splitUploadPath(ROOT, `${ROOT}/u1/r1/.ddev/config.yaml`)).toBeNull();
  });

  it('refuses a path under a different storage root', () => {
    expect(splitUploadPath(ROOT, `/srv/other/_uploads/u1/db.sql`)).toBeNull();
  });

  it('refuses a name directly in the uploads directory', () => {
    // Every path the api writes carries the owner segment; one without it is a shape this code
    // never produced, so it is refused rather than guessed at.
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/db.sql`)).toBeNull();
  });

  it('refuses a path nested deeper than <owner>/<name>', () => {
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/u1/sub/db.sql`)).toBeNull();
  });

  it('refuses an empty segment', () => {
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads//db.sql`)).toBeNull();
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/u1/`)).toBeNull();
  });

  it('matches a path the api wrote under a relative storage root', () => {
    // The api joins its paths with `path.join`, so a relative root is stored relative too.
    expect(splitUploadPath('data/repos', 'data/repos/_uploads/u1/repo.zip')).toEqual({
      anchor: 'data/repos',
      rel: '_uploads/u1/repo.zip',
    });
    expect(splitUploadPath('./data/repos/', 'data/repos/_uploads/u1/repo.zip')).toEqual({
      anchor: './data/repos/',
      rel: '_uploads/u1/repo.zip',
    });
  });

  it('matches a path the api wrote under the filesystem root', () => {
    expect(splitUploadPath('/', '/_uploads/u1/repo.zip')).toEqual({
      anchor: '/',
      rel: '_uploads/u1/repo.zip',
    });
  });

  it('refuses a path the api would not have written, even one that resolves to it', () => {
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/x/../u1/db.sql`)).toBeNull();
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/u1/db.sql/`)).toBeNull();
  });

  it('refuses a traversal segment rather than leaving it to the primitive', () => {
    // It splits into exactly two segments, so the shape check alone would pass it. `toSafeRel`
    // would then THROW `invalid-path` inside the primitive, and both callers wrap that in a
    // `.catch` — so the throw would be swallowed and read as "nothing to do".
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/../db.sql`)).toBeNull();
    expect(splitUploadPath(ROOT, `${ROOT}/_uploads/u1/..`)).toBeNull();
  });
});
