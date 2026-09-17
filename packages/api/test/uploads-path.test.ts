import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uploadFileRel, uploadsRel, uploadsStorageRoot } from '../src/lib/uploads.js';

const ROOT = '/var/lib/haive/test-repos';

let previous: string | undefined;
beforeEach(() => {
  previous = process.env.REPO_STORAGE_ROOT;
  process.env.REPO_STORAGE_ROOT = ROOT;
});
afterEach(() => {
  if (previous === undefined) delete process.env.REPO_STORAGE_ROOT;
  else process.env.REPO_STORAGE_ROOT = previous;
});

describe('uploadsStorageRoot', () => {
  it('reads the volume from the environment', () => {
    expect(uploadsStorageRoot()).toBe(ROOT);
  });

  it('falls back to the packaged default', () => {
    delete process.env.REPO_STORAGE_ROOT;
    expect(uploadsStorageRoot()).toBe('/var/lib/haive/repos');
  });
});

describe('uploadFileRel', () => {
  it('splits a path this api wrote into the rel below the storage root', () => {
    expect(uploadFileRel('u1', `${ROOT}/_uploads/u1/db-abc.sql`)).toBe('_uploads/u1/db-abc.sql');
  });

  it('refuses another user directory', () => {
    // The rel is built from the CALLER's own userId, so a row naming someone else's directory can
    // never be read or deleted through it.
    expect(uploadFileRel('u1', `${ROOT}/_uploads/u2/db-abc.sql`)).toBeNull();
  });

  it('refuses a path outside the uploads directory', () => {
    expect(uploadFileRel('u1', `${ROOT}/u1/r1/.ddev/config.yaml`)).toBeNull();
  });

  it('refuses a path under a different storage root', () => {
    expect(uploadFileRel('u1', `/srv/other/_uploads/u1/db.sql`)).toBeNull();
  });

  it('refuses a name nested deeper than the uploads directory', () => {
    expect(uploadFileRel('u1', `${ROOT}/_uploads/u1/sub/db.sql`)).toBeNull();
  });

  it('refuses an empty name', () => {
    expect(uploadFileRel('u1', `${ROOT}/_uploads/u1/`)).toBeNull();
  });

  it('refuses a traversal name rather than leaving it to the primitive', () => {
    // It is a single segment, so the shape check alone would pass it. `toSafeRel` would then THROW
    // `invalid-path` inside the primitive, and several callers wrap that in a `.catch` — so the
    // throw would be swallowed and read as "nothing to do".
    expect(uploadFileRel('u1', `${ROOT}/_uploads/u1/..`)).toBeNull();
  });

  it('tracks the storage root at call time, not at import', () => {
    process.env.REPO_STORAGE_ROOT = '/srv/moved';
    expect(uploadFileRel('u1', `/srv/moved/${uploadsRel('u1')}/db.sql`)).toBe('_uploads/u1/db.sql');
  });
});
