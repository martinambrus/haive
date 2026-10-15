'use client';

import { useEffect, useState } from 'react';
import {
  moduleOpenCapped,
  moduleOpenTasks,
  postModulePurge,
  type ApiError,
  type ModuleOpenTask,
  type ModulePurgeResponse,
} from '@/lib/api-client';
import { useViewerId } from '@/lib/use-viewer-id';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { ModuleTaskTitle, ModuleTasksCapNote } from '@/components/module-tasks-open-dialog';
import { Button, FormError, Input } from '@/components/ui';

export const modulePurgeArmed = (typed: string, moduleId: string): boolean =>
  moduleId.length > 0 && typed === moduleId;

export function ModulePurgeDialog({
  target,
  onClose,
  onDone,
}: {
  target: { id: string; tornDown: boolean } | null;
  onClose: () => void;
  onDone: (result: ModulePurgeResponse) => void;
}) {
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<ModuleOpenTask[]>([]);
  const [capped, setCapped] = useState(false);

  const viewerId = useViewerId(target !== null);

  const id = target?.id ?? null;
  useEffect(() => {
    setTyped('');
    setError(null);
    setBlockedBy([]);
    setCapped(false);
  }, [id]);

  const armed = id !== null && modulePurgeArmed(typed, id) && !running;

  function close() {
    if (running) return;
    onClose();
  }

  async function confirm() {
    if (!armed || id === null) return;
    setRunning(true);
    setError(null);
    setBlockedBy([]);
    setCapped(false);
    try {
      onDone(await postModulePurge(id, typed));
    } catch (err) {
      setBlockedBy(moduleOpenTasks(err as ApiError));
      setCapped(moduleOpenCapped(err as ApiError));
      setError((err as ApiError).message ?? 'Failed to purge the module');
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent role="alertdialog" aria-labelledby="module-purge-title">
        <DialogHeader>
          <DialogTitle id="module-purge-title">Purge module data</DialogTitle>
          <InlineMarkdown
            className="text-sm text-neutral-300 [overflow-wrap:anywhere]"
            body={`Permanently delete everything Haive keeps for \`${id}\`: its database, its settings and the task types it seeded that no task uses. This cannot be undone.`}
          />
          {target !== null && !target.tornDown && (
            <InlineMarkdown
              className="text-sm text-amber-300 [overflow-wrap:anywhere]"
              body="The module's own teardown never ran, so anything it keeps outside its database and settings stays where it is."
            />
          )}
        </DialogHeader>
        <label className="flex flex-col gap-1 text-sm text-neutral-400 [&_code]:select-all [&_code]:text-indigo-300 [&_code]:[overflow-wrap:anywhere]">
          <span>
            Type <code>{id}</code> to confirm
          </span>
          <Input
            autoFocus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void confirm()}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {blockedBy.length > 0 && (
          <ul className="mt-3 flex max-h-48 flex-col gap-1 overflow-y-auto">
            {blockedBy.map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-3 text-sm">
                <ModuleTaskTitle task={t} viewerId={viewerId} />
                <span className="shrink-0 text-xs text-neutral-500">{t.status}</span>
              </li>
            ))}
          </ul>
        )}
        {blockedBy.length > 0 && capped && <ModuleTasksCapNote />}
        <div className="mt-3">
          <FormError message={error} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            disabled={running}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            disabled={!armed}
            onClick={() => void confirm()}
          >
            {running ? 'Purging…' : 'Purge'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
