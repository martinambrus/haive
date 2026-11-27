import type { TaskActionNotice as Notice } from '@/lib/task-state';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

export function TaskActionNotice({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className={
        notice.warning
          ? 'rounded-md border border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-200'
          : 'rounded-md border border-neutral-800 px-3 py-2 text-sm text-neutral-400'
      }
    >
      <InlineMarkdown body={notice.message} />
    </div>
  );
}
