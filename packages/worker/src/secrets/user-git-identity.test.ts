import { describe, it, expect } from 'vitest';
import type { Database } from '@haive/database';
import { resolveGitEnv } from './user-git-identity.js';

interface Rows {
  task?: { repositoryId: string | null };
  repository?: { credentialsSecretId: string | null };
  credential?: { gitName: string | null; gitEmail: string | null };
  user?: { gitName: string | null; gitEmail: string | null };
}

/** Every lookup in the resolver is a `findFirst` keyed on a primary key, so a stub that
 *  ignores the predicate and returns the single row for that table is faithful. */
function dbFor(rows: Rows): Database {
  return {
    query: {
      tasks: { findFirst: async () => rows.task },
      repositories: { findFirst: async () => rows.repository },
      repoCredentials: { findFirst: async () => rows.credential },
      users: { findFirst: async () => rows.user },
    },
  } as unknown as Database;
}

const WORK = { gitName: 'Work Me', gitEmail: 'me@work.test' };
const GLOBAL = { gitName: 'Global Me', gitEmail: 'me@personal.test' };

function envFor(name: string, email: string) {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

describe('resolveGitEnv', () => {
  it("uses the bound credential's identity over the global one", async () => {
    const db = dbFor({
      task: { repositoryId: 'repo1' },
      repository: { credentialsSecretId: 'cred1' },
      credential: WORK,
      user: GLOBAL,
    });
    expect(await resolveGitEnv(db, { userId: 'u1', taskId: 't1' })).toEqual(
      envFor('Work Me', 'me@work.test'),
    );
  });

  it('accepts a repositoryId directly, without a task', async () => {
    const db = dbFor({
      repository: { credentialsSecretId: 'cred1' },
      credential: WORK,
      user: GLOBAL,
    });
    expect(await resolveGitEnv(db, { userId: 'u1', repositoryId: 'repo1' })).toEqual(
      envFor('Work Me', 'me@work.test'),
    );
  });

  it('ignores a half-filled credential identity and falls back to the global one', async () => {
    const db = dbFor({
      task: { repositoryId: 'repo1' },
      repository: { credentialsSecretId: 'cred1' },
      credential: { gitName: 'Work Me', gitEmail: null },
      user: GLOBAL,
    });
    expect(await resolveGitEnv(db, { userId: 'u1', taskId: 't1' })).toEqual(
      envFor('Global Me', 'me@personal.test'),
    );
  });

  it('treats a whitespace-only credential identity as unset', async () => {
    const db = dbFor({
      task: { repositoryId: 'repo1' },
      repository: { credentialsSecretId: 'cred1' },
      credential: { gitName: '  ', gitEmail: '  ' },
      user: GLOBAL,
    });
    expect(await resolveGitEnv(db, { userId: 'u1', taskId: 't1' })).toEqual(
      envFor('Global Me', 'me@personal.test'),
    );
  });

  it('falls back to the global identity when the repo has no credential', async () => {
    const db = dbFor({
      task: { repositoryId: 'repo1' },
      repository: { credentialsSecretId: null },
      user: GLOBAL,
    });
    expect(await resolveGitEnv(db, { userId: 'u1', taskId: 't1' })).toEqual(
      envFor('Global Me', 'me@personal.test'),
    );
  });

  it('falls back to the global identity when the task has no repository', async () => {
    const db = dbFor({ task: { repositoryId: null }, user: GLOBAL });
    expect(await resolveGitEnv(db, { userId: 'u1', taskId: 't1' })).toEqual(
      envFor('Global Me', 'me@personal.test'),
    );
  });

  it('returns {} when neither the credential nor the user carries an identity', async () => {
    const db = dbFor({
      task: { repositoryId: 'repo1' },
      repository: { credentialsSecretId: 'cred1' },
      credential: { gitName: null, gitEmail: null },
      user: { gitName: null, gitEmail: null },
    });
    expect(await resolveGitEnv(db, { userId: 'u1', taskId: 't1' })).toEqual({});
  });

  it('returns {} for a missing user with no task and no repository', async () => {
    expect(await resolveGitEnv(dbFor({}), { userId: 'u1' })).toEqual({});
  });
});
