'use client';

import { useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { buildPlan, startTask, uploadTaskAttachment } from '@/lib/api-client';
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
  Input,
} from '@/components/ui';

/**
 * The three ways a plan starts.
 *
 * Ordered by which one most people need, not by which shipped first. A repo with
 * a knowledge base can be mined; everything else — a blank repo, a project that
 * does not exist yet, a plan somebody already wrote down — goes through the
 * brief-and-files flow, which is why that one is primary and Markdown import is
 * a case of it (attach one `.md`) rather than its own control.
 *
 * The interesting part is the ORDER of the create. Every other create-then-upload
 * flow in the app enqueues first and uploads afterwards, which is safe there
 * because nothing reads the files immediately. Here the worker picks the job up
 * at once and the first step reads the uploads directory, so the task is created
 * UNSTARTED, the files are streamed, and only then is it started. An upload that
 * fails therefore cannot start anything: the draft survives, its Attachments tab
 * is the repair surface, and Start finishes the job.
 */

type UploadState = 'pending' | 'uploading' | 'done' | 'failed';

interface Selected {
  file: File;
  description: string;
  state: UploadState;
  error: string | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function PlanStarter({
  repositoryId,
  onboarded,
  onNavigate,
  onCreateRoot,
}: {
  repositoryId: string;
  /** null means "not known yet", which is treated as onboarded — the same
   *  reading the rest of the page uses. */
  onboarded: boolean | null;
  onNavigate: (taskId: string) => void;
  onCreateRoot: (title: string) => Promise<void>;
}) {
  const [brief, setBrief] = useState('');
  const [files, setFiles] = useState<Selected[]>([]);
  const [rootTitle, setRootTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  /** The unstarted draft a partial upload left behind. Its presence is what makes
   *  a retry reuse the SAME task: creating a second one would leave the user with
   *  two half-built plans and no way to tell which is which. */
  const [draftTaskId, setDraftTaskId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  function addFiles(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    setFiles((prev) => [
      ...prev,
      ...Array.from(picked)
        // Same name and size twice is a double-pick, not two documents.
        .filter((f) => !prev.some((p) => p.file.name === f.name && p.file.size === f.size))
        .map((file) => ({ file, description: '', state: 'pending' as const, error: null })),
    ]);
  }

  function patch(index: number, over: Partial<Selected>) {
    setFiles((prev) => prev.map((f, i) => (i === index ? { ...f, ...over } : f)));
  }

  async function describeAndBuild() {
    const description = brief.trim();
    setBusy(true);
    setError(null);
    try {
      // With no files there is nothing to race, so the ordinary single-shot
      // create still applies and the user is not asked to wait for two calls.
      const deferStart = files.length > 0;
      setProgress(deferStart ? (draftTaskId ? 'Retrying…' : 'Creating the task…') : null);
      // Reuse the draft a previous attempt left unstarted. The upload loop below
      // skips rows already marked done, so a retry re-sends only what failed.
      const taskId =
        draftTaskId ??
        (
          await buildPlan(repositoryId, {
            mode: 'greenfield',
            ...(description ? { description } : {}),
            ...(deferStart ? { deferStart } : {}),
          })
        ).taskId;

      if (!deferStart) return onNavigate(`/tasks/${taskId}`);

      let failed = 0;
      for (const [index, entry] of files.entries()) {
        if (entry.state === 'done') continue;
        patch(index, { state: 'uploading', error: null });
        setProgress(`Uploading ${entry.file.name} (${index + 1} of ${files.length})…`);
        try {
          await uploadTaskAttachment(taskId, entry.file, entry.description);
          patch(index, { state: 'done' });
        } catch (e) {
          failed += 1;
          patch(index, {
            state: 'failed',
            error: e instanceof Error ? e.message : 'Upload failed',
          });
        }
      }

      if (failed > 0) {
        // Deliberately NOT started, and deliberately NOT navigated away from.
        // The draft is intact and reachable, so nothing is lost — but this screen
        // is the only one showing WHICH file failed and why (each row carries its
        // own message), and navigating on failure threw all of that away the
        // instant it was written. The user stays here, reads it, and follows the
        // link when they are ready.
        setError(
          `${failed} of ${files.length} file(s) failed to upload, so the build was NOT started. Nothing was lost — the draft task is waiting. Fix the files listed above and press "Retry the failed uploads" (only those are re-sent), or open the draft and attach them there.`,
        );
        setProgress(null);
        setDraftTaskId(taskId);
        setBusy(false);
        return;
      }

      setProgress('Starting the build…');
      await startTask(taskId);
      onNavigate(`/tasks/${taskId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the build');
      setProgress(null);
      // Only on failure: on success the page is navigating away, and re-enabling
      // the button mid-navigation invites a second build.
      setBusy(false);
    }
  }

  async function buildFromRepo() {
    setBusy(true);
    setError(null);
    try {
      const { taskId } = await buildPlan(repositoryId, { mode: 'from_repo' });
      onNavigate(`/tasks/${taskId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start the build');
      setBusy(false);
    }
  }

  async function createRoot() {
    const title = rootTitle.trim();
    if (!title) return;
    setBusy(true);
    try {
      await onCreateRoot(title);
      setRootTitle('');
    } finally {
      setBusy(false);
    }
  }

  const canDescribe = brief.trim().length > 0 || files.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>No plan yet</CardTitle>
        <CardDescription>
          A plan is a durable tree of what this project is meant to be, drilling down from the whole
          product to leaves you can turn into tasks. Describe what you want built (attaching
          whatever you have already written), derive one from this repository, or start it by hand.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-4">
        <FormError message={error} />

        {/* Primary. Works on a repository created empty, which is the case none
            of the other two serve. */}
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-neutral-200">Describe a new project</p>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            // Already written to the draft. Editing it here would change nothing,
            // so the field says so rather than quietly discarding the edit.
            disabled={draftTaskId !== null}
            title={
              draftTaskId
                ? 'Already saved on the draft task. Edit it there if it needs changing.'
                : undefined
            }
            placeholder="A content management system for small clubs: pages, members, a mailing list…"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          />

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip className="mr-1 h-3.5 w-3.5" />
              Attach files
            </Button>
            <span className="text-xs text-neutral-500">
              A written plan, requirements (.docx), a spreadsheet, a PDF, wireframes. Word, Excel
              and PDF are converted to text the agent can read; images need a model that can see
              them.
            </span>
          </div>

          {files.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {files.map((entry, index) => (
                <li
                  key={`${entry.file.name}:${entry.file.size}`}
                  className="flex flex-wrap items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5"
                >
                  <span className="text-xs text-neutral-200">{entry.file.name}</span>
                  <span className="text-[11px] text-neutral-500">
                    {formatBytes(entry.file.size)}
                  </span>
                  <Input
                    value={entry.description}
                    onChange={(e) => patch(index, { description: e.target.value })}
                    placeholder="What is this? (optional)"
                    className="h-7 min-w-40 flex-1 text-xs"
                    disabled={busy}
                  />
                  {/* The state is on the row that has it, so a single failure in
                      a batch of eight is visible rather than summarised away. */}
                  {entry.state === 'uploading' && (
                    <span className="text-[11px] text-indigo-300">Uploading…</span>
                  )}
                  {entry.state === 'done' && (
                    <span className="text-[11px] text-emerald-400">Uploaded</span>
                  )}
                  {entry.state === 'failed' && (
                    <span className="text-[11px] text-rose-400">{entry.error ?? 'Failed'}</span>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Remove ${entry.file.name}`}
                    onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                    className="text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy || !canDescribe}
              onClick={() => void describeAndBuild()}
            >
              {draftTaskId ? 'Retry the failed uploads' : 'Draft a plan from this'}
            </Button>
            {/* The draft a partial upload left behind. An escape hatch, not the
                main route: pressing Retry above is the shorter path, and this is
                for someone who would rather finish on the task page. */}
            {draftTaskId && (
              <a
                href={`/tasks/${draftTaskId}`}
                className="text-xs text-indigo-300 underline hover:text-indigo-200"
              >
                Open the draft task instead
              </a>
            )}
            {progress && <span className="text-xs text-indigo-300">{progress}</span>}
          </div>
        </div>

        {/* A repo that was never onboarded has no knowledge base to mine. */}
        {onboarded !== false && (
          <div className="flex flex-col gap-1.5 border-t border-neutral-800 pt-3">
            <p className="text-xs font-medium text-neutral-400">Or build from this repository</p>
            <div>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void buildFromRepo()}
              >
                Build from the knowledge base
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-neutral-800 pt-3">
          <Input
            value={rootTitle}
            onChange={(e) => setRootTitle(e.target.value)}
            placeholder="Or name the project to start by hand"
            className="w-72"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !rootTitle.trim()}
            onClick={() => void createRoot()}
          >
            Create
          </Button>
        </div>
      </div>
    </Card>
  );
}
