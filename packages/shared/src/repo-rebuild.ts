import path from 'node:path';
import { and, eq, isNotNull, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/** A rebuild keeps the old folder, but cannot leave an unfinished task pointing into it. */
export async function checkoutWorktreeRefusal(
  db: Pick<Database, 'query'>,
  repositoryId: string,
  checkout: string,
): Promise<string | null> {
  const tasks = await db.query.tasks.findMany({
    where: and(
      eq(schema.tasks.repositoryId, repositoryId),
      notInArray(schema.tasks.status, ['completed', 'cancelled']),
      isNotNull(schema.tasks.worktreePath),
    ),
    columns: { worktreePath: true },
  });
  const count = tasks.filter(({ worktreePath }) => {
    if (!worktreePath) return false;
    const rel = path.relative(checkout, worktreePath);
    return (
      rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
    );
  }).length;
  return count > 0
    ? `${count} ${count === 1 ? 'task has' : 'tasks have'} a worktree inside this checkout. Finish or cancel ${count === 1 ? 'it' : 'them'} before rebuilding.`
    : null;
}
