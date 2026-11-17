import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@haive/database';
import { lstatNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import { isBranchName } from '@haive/shared/git-args';
import { splitWorktreePath } from '../repo/worktree-paths.js';

export const EVENT = 'worktree.no_change_cleanup';
export const setupSchema = z.object({
  mode: z.literal('worktree'),
  worktreePath: z.string(),
  branchName: z.string().refine(isBranchName),
  baseBranch: z.string().refine(isBranchName),
});
export type Setup = z.infer<typeof setupSchema>;
export const journalSchema = setupSchema.extend({
  version: z.literal(1),
  // Absent on the original journal format, whose staged tree was already removable.
  phase: z.enum(['staging', 'removing']).optional(),
  id: z.uuid(),
  dev: z.string(),
  ino: z.string(),
  head: z.string().regex(/^[a-f0-9]{40,64}$/),
});
export type Journal = z.infer<typeof journalSchema>;

export const refuse = (reason: string): never => {
  throw new Error(
    `No-change cleanup refused: ${reason}. Keep the worktree and branch; resolve the problem, then Retry.`,
  );
};
export const stageRel = (journal: Journal) => `.haive/no-change-cleanup/${journal.id}`;
export const sameIdentity = (
  info: NonNullable<Awaited<ReturnType<typeof lstatNoFollow>>>,
  journal: Journal,
) =>
  info.kind === 'directory' &&
  String(info.stats.dev) === journal.dev &&
  String(info.stats.ino) === journal.ino;

/** Cancel is a discard action. Called only after the task's sandbox listing is empty;
 * failures keep cancellation unfinished so its ordinary redrive retries this removal. */
export async function discardNoChangeCleanupDirectories(
  db: Database,
  taskId: string,
): Promise<void> {
  const events = await db.query.taskEvents.findMany({
    where: and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, EVENT)),
  });
  if (events.length === 0) return;
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { status: true, runListSnapshot: true },
  });
  if (task?.status !== 'cancelled' || !task.runListSnapshot?.includes('12-no-change-cleanup'))
    return;
  for (const event of events) {
    const saved = journalSchema.parse(event.payload);
    const split = splitWorktreePath(saved.worktreePath);
    if (!split) return refuse('the cleanup recovery path is invalid');
    const current = await lstatNoFollow(split.anchor, stageRel(saved), { strict: true });
    if (current && !sameIdentity(current, saved))
      return refuse('the cleanup recovery directory changed');
    await removeNoFollow(split.anchor, stageRel(saved), {
      recursive: true,
      repairPermissions: true,
    });
  }
}
