'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { MODULE_DEPENDENTS_CAP, parseStepId } from '@haive/shared/modularity';
import {
  patchModuleUrgent,
  type ApiError,
  type ModuleOpenTask,
  type ModuleUrgentResponse,
} from '@/lib/api-client';
import { inlineCode } from '@/lib/project-state-conflicts';
import { useViewerId } from '@/lib/use-viewer-id';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Badge, Button, FormError } from '@/components/ui';

export interface ModuleTasksBlocked {
  moduleId: string;
  name: string | null;
  tasks: ModuleOpenTask[];
  capped: boolean;
}

const COPY_TAIL =
  'Module code already running finishes its current call, and its background jobs stop at the next worker restart.';

const inModuleStep = (stepId: string | null, moduleId: string): boolean => {
  const parsed = stepId === null ? null : parseStepId(stepId);
  return parsed?.kind === 'module' && parsed.moduleId === moduleId;
};

function turnOffCopy({ moduleId, name, tasks }: ModuleTasksBlocked): string {
  const lead = `Turns ${inlineCode(name || moduleId)} off now.`;
  const inStep = tasks.filter((t) => inModuleStep(t.currentStepId, moduleId)).length;
  if (inStep === 0) {
    return `${lead} No listed task is in one of its steps now, so none is stopped; each fails when it next runs one of its steps. ${COPY_TAIL}`;
  }
  const count = inStep === 1 ? '1 listed task is' : `${inStep} listed tasks are`;
  return `${lead} A task whose agent is running in one of its steps is stopped (Retry it once the module is on again); every other task fails when it next runs one of its steps. ${count} in one of its steps now. ${COPY_TAIL}`;
}

export function moduleOffNotice(
  name: string,
  result: ModuleUrgentResponse,
  titles: ReadonlyMap<string, string>,
): string {
  const stopped = `${result.stopped.length} task${result.stopped.length === 1 ? '' : 's'} stopped`;
  return [
    `Turned off ${name}: ${stopped}, ${result.left.length} left (they fail when they reach one of its steps), ${result.failed.length} could not be stopped.`,
    ...result.failed.map((f) => `- ${titles.get(f.id) ?? f.id}: ${f.error}`),
  ].join('\n');
}

export function ModuleTaskTitle({
  task,
  viewerId,
}: {
  task: ModuleOpenTask;
  viewerId: string | null;
}) {
  // GET /tasks/:id is owner-scoped: anyone else's task page is a 404.
  if (viewerId === null || task.ownerId !== viewerId) {
    return <span className="min-w-0 text-neutral-200 [overflow-wrap:anywhere]">{task.title}</span>;
  }
  // New tab, so this page and what is typed on it survive while the task is dealt with.
  return (
    <Link
      href={`/tasks/${task.id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="min-w-0 text-indigo-300 underline [overflow-wrap:anywhere]"
    >
      {task.title} ↗
    </Link>
  );
}

export function ModuleTasksCapNote() {
  return (
    <p className="mt-2 text-xs text-amber-300">{`Showing the first ${MODULE_DEPENDENTS_CAP}.`}</p>
  );
}

export function ModuleTasksOpenDialog({
  blocked,
  onClose,
  onDone,
}: {
  blocked: ModuleTasksBlocked | null;
  onClose: () => void;
  onDone: (result: ModuleUrgentResponse) => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const viewerId = useViewerId(blocked !== null);

  if (blocked === null) return null;
  const { moduleId } = blocked;
  const name = blocked.name || moduleId;

  function close() {
    if (inFlight.current) return;
    setError(null);
    onClose();
  }

  async function turnOff() {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setError(null);
    try {
      onDone(await patchModuleUrgent(moduleId));
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to turn the module off');
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent role="alertdialog" aria-labelledby="module-tasks-open-title">
        <DialogHeader>
          <DialogTitle id="module-tasks-open-title">Module still in use</DialogTitle>
          <InlineMarkdown
            className="text-sm text-neutral-300 [overflow-wrap:anywhere]"
            body={`Live tasks still use \`${moduleId}\`. Finish or cancel them, then deactivate it again.`}
          />
        </DialogHeader>
        <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
          {blocked.tasks.map((t) => (
            <li key={t.id} className="flex flex-col gap-1 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <ModuleTaskTitle task={t} viewerId={viewerId} />
                <span className="shrink-0 text-xs text-neutral-500">{t.status}</span>
              </div>
              {t.currentStepId !== null && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
                  <code className="font-mono [overflow-wrap:anywhere]">{t.currentStepId}</code>
                  {inModuleStep(t.currentStepId, moduleId) && (
                    <Badge variant="warning">{`in a ${name} step`}</Badge>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        {blocked.capped && <ModuleTasksCapNote />}
        <InlineMarkdown
          className="mt-3 text-sm text-neutral-300 [overflow-wrap:anywhere]"
          body={turnOffCopy(blocked)}
        />
        <div className="mt-3">
          <FormError message={error} />
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
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
            disabled={running}
            onClick={() => void turnOff()}
          >
            {running ? 'Turning off…' : 'Turn off now'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
