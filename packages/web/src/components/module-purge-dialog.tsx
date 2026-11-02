'use client';

import { useEffect, useRef, useState } from 'react';
import {
  getModulePurgePreview,
  moduleOpenCapped,
  moduleOpenTasks,
  postModulePurge,
  type ApiError,
  type ModuleOpenTask,
  type ModulePurgeResponse,
  type ModulePurgePreview,
} from '@/lib/api-client';
import { moduleIntegrationCountsCopy, validModulePurgePreview } from '@/lib/module-purge';
import { useViewerId } from '@/lib/use-viewer-id';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { ModuleTaskTitle, ModuleTasksCapNote } from '@/components/module-tasks-open-dialog';
import { Button, FormError, Input } from '@/components/ui';

export const modulePurgeArmed = (typed: string, moduleId: string): boolean =>
  moduleId.length > 0 && typed === moduleId;

type Props = {
  target: { id: string; tornDown: boolean } | null;
  onClose: () => void;
  onDone: (result: ModulePurgeResponse) => void;
};

export function ModulePurgeDialog(props: Props) {
  return props.target === null ? null : (
    <ModulePurgeDialogTarget key={props.target.id} {...props} />
  );
}

function ModulePurgeDialogTarget({ target, onClose, onDone }: Props) {
  const [typed, setTyped] = useState('');
  const [preview, setPreview] = useState<ModulePurgePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<ModuleOpenTask[]>([]);
  const [capped, setCapped] = useState(false);

  const viewerId = useViewerId(target !== null);

  const id = target?.id ?? null;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (id === null) return;
    let live = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    setPreview(null);
    setPreviewError(null);
    getModulePurgePreview(id, controller.signal)
      .then((value) => {
        if (!live) return;
        if (controller.signal.aborted)
          throw new Error('Loading integration counts timed out. Retry to continue.');
        if (!validModulePurgePreview(value, id))
          throw new Error('Integration counts could not be verified');
        setPreview(value);
      })
      .catch((err: unknown) => {
        if (live)
          setPreviewError(
            controller.signal.aborted
              ? 'Loading integration counts timed out. Retry to continue.'
              : (err as Error).message || 'Failed to load integration counts',
          );
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [id, revision]);

  const armed =
    id !== null &&
    modulePurgeArmed(typed, id) &&
    !running &&
    preview !== null &&
    preview.moduleId === id &&
    previewError === null;

  function close() {
    if (busy.current) return;
    onClose();
  }

  async function confirm() {
    if (!armed || id === null || busy.current) return;
    busy.current = true;
    setRunning(true);
    setError(null);
    setBlockedBy([]);
    setCapped(false);
    try {
      const result = await postModulePurge(id, typed);
      if (mounted.current) onDone(result);
    } catch (err) {
      if (!mounted.current) return;
      setPreview(null);
      setRevision((value) => value + 1);
      setBlockedBy(moduleOpenTasks(err as ApiError));
      setCapped(moduleOpenCapped(err as ApiError));
      setError((err as ApiError).message ?? 'Failed to purge the module');
    } finally {
      busy.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent
        role="alertdialog"
        aria-labelledby="module-purge-title"
        className="max-h-[90dvh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle id="module-purge-title">Purge module data</DialogTitle>
          <InlineMarkdown
            className="text-sm text-neutral-300 [overflow-wrap:anywhere]"
            body={`Permanently delete the module data Haive keeps for \`${id}\`: its database, its settings and the task types it seeded that no task uses. Its owned integration configuration and account bindings are also removed. This cannot be undone.`}
          />
          {target !== null && !target.tornDown && (
            <InlineMarkdown
              className="text-sm text-amber-300 [overflow-wrap:anywhere]"
              body="The module's own teardown never ran, so anything it keeps outside its database and settings stays where it is."
            />
          )}
        </DialogHeader>
        <div className="mb-4 text-sm text-neutral-300 [overflow-wrap:anywhere]" aria-live="polite">
          <InlineMarkdown
            body={
              preview === null
                ? previewError === null
                  ? 'Loading integration counts…'
                  : 'Integration counts are unavailable. Retry before confirming.'
                : `Current integration data to remove: ${moduleIntegrationCountsCopy(preview.integrations)}. Counts are checked again when purging.`
            }
          />
          <InlineMarkdown body="Call history, invocation records, audit history and Git credentials are kept. Saved account preferences include installation defaults. Grants include repository allow-lists; repository restrictions still apply." />
          <FormError message={previewError} />
          {previewError !== null && (
            <Button
              type="button"
              variant="secondary"
              className="mt-2 h-11"
              onClick={() => {
                setPreview(null);
                setPreviewError(null);
                setRevision((value) => value + 1);
              }}
            >
              Retry counts
            </Button>
          )}
        </div>
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
