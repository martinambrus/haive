import Link from 'next/link';
import type { BlockingTask } from '@/lib/api-client';

const TITLE_CLASS = 'truncate text-sm font-medium text-neutral-100';

/** GET /tasks/:id answers only a task's owner, so another user's task is named, not linked. */
export function BlockingTaskTitle({
  task,
  viewerId,
}: {
  task: Pick<BlockingTask, 'id' | 'title' | 'ownerId'>;
  viewerId: string;
}) {
  const label = task.title || task.id;
  if (task.ownerId !== viewerId) return <span className={TITLE_CLASS}>{label}</span>;
  return (
    <Link href={`/tasks/${task.id}`} className={`${TITLE_CLASS} hover:underline`}>
      {label}
    </Link>
  );
}
