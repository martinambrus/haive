import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export interface GitEnvScope {
  userId: string;
  /** Resolves to the task's repository. Ignored when repositoryId is given. */
  taskId?: string;
  /** Skips the task lookup. Used by the repo-scoped terminal, which has no task. */
  repositoryId?: string;
}

interface Identity {
  name: string;
  email: string;
}

/** Both halves or nothing: a credential carrying only a name would otherwise mix with the
 *  global email and author commits as `Work Name <personal@email>`. */
function pair(name: string | null | undefined, email: string | null | undefined): Identity | null {
  const n = name?.trim();
  const e = email?.trim();
  return n && e ? { name: n, email: e } : null;
}

async function resolveRepositoryId(db: Database, scope: GitEnvScope): Promise<string | null> {
  if (scope.repositoryId) return scope.repositoryId;
  if (!scope.taskId) return null;
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, scope.taskId),
    columns: { repositoryId: true },
  });
  return task?.repositoryId ?? null;
}

/** The identity on the credential the repository is bound to, if any. Repos with no
 *  credential (public clone, local path, uploaded archive) have nowhere to hang one. */
async function resolveCredentialIdentity(
  db: Database,
  repositoryId: string,
): Promise<Identity | null> {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { credentialsSecretId: true },
  });
  if (!repo?.credentialsSecretId) return null;
  const credential = await db.query.repoCredentials.findFirst({
    where: eq(schema.repoCredentials.id, repo.credentialsSecretId),
    columns: { gitName: true, gitEmail: true },
  });
  return pair(credential?.gitName, credential?.gitEmail);
}

/** Git commit identity for a task/repository, as the four env vars git reads.
 *
 *  Precedence: the bound credential's identity, then the user's global identity. Returns `{}`
 *  when neither is configured — callers that create commits substitute their own fallback
 *  identity, while the terminal and cli-exec sandbox deliberately export no GIT_* vars at all.
 */
export async function resolveGitEnv(
  db: Database,
  scope: GitEnvScope,
): Promise<Record<string, string>> {
  const repositoryId = await resolveRepositoryId(db, scope);

  let identity = repositoryId ? await resolveCredentialIdentity(db, repositoryId) : null;

  if (!identity) {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, scope.userId),
      columns: { gitName: true, gitEmail: true },
    });
    identity = pair(user?.gitName, user?.gitEmail);
  }

  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
