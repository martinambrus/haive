import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

export async function resolveUserGitEnv(
  db: Database,
  userId: string,
): Promise<Record<string, string>> {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.id, userId),
    columns: { gitName: true, gitEmail: true },
  });
  if (!user) return {};
  const name = user.gitName?.trim();
  const email = user.gitEmail?.trim();
  if (!name || !email) return {};
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}
