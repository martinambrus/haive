'use client';

import Link from 'next/link';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button } from '@/components/ui';
import type { ModuleOpenTask } from '@/lib/api-client';

export function ModuleTasksOpenDialog({
  blocked,
  onClose,
}: {
  blocked: { moduleId: string; tasks: ModuleOpenTask[] } | null;
  onClose: () => void;
}) {
  if (blocked === null) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent role="alertdialog" aria-labelledby="module-tasks-open-title">
        <DialogHeader>
          <DialogTitle id="module-tasks-open-title">Module still in use</DialogTitle>
          <InlineMarkdown
            className="text-sm text-neutral-300 [overflow-wrap:anywhere]"
            body={`Live tasks still use \`${blocked.moduleId}\`. Finish or cancel them, then deactivate it again.`}
          />
        </DialogHeader>
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {blocked.tasks.map((t) => (
            <li key={t.id} className="flex items-baseline justify-between gap-3 text-sm">
              {/* New tab, so the admin keeps this page to retry from once the task is dealt with. */}
              <Link
                href={`/tasks/${t.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 text-indigo-300 underline [overflow-wrap:anywhere]"
              >
                {t.title} ↗
              </Link>
              <span className="shrink-0 text-xs text-neutral-500">{t.status}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
