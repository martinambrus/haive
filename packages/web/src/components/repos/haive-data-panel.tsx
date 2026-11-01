'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  HaiveDataRefusal,
  HaiveDataSaveResult,
  HaiveDataStatus,
} from '@haive/shared/haive-data';
import { api } from '@/lib/api-client';
import { Button, Card } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { ProjectStateConflictsBanner } from '@/components/project-state-conflicts-banner';

const reasons: Record<HaiveDataRefusal['code'], string> = {
  checkout_unreadable: 'The checkout could not be read.',
  branch_unreadable: 'The current branch could not be read.',
  origin_unreadable: 'The origin could not be read or its address is not supported.',
  git_operation_unreadable: 'An open Git operation could not be checked.',
  checkout_missing: 'The checkout is missing.',
  not_git_checkout: 'The checkout is not a usable Git repository.',
  root_claim: 'Repository setup or maintenance holds the checkout.',
  detached_head: 'Check out a named branch before pushing.',
  no_origin: 'Link this repository to an origin before pushing.',
  write_pending: 'A record write is pending recovery. Wait for it to finish, then refresh.',
  git_operation: 'Finish the open merge, rebase, cherry-pick or revert first.',
  checkout_held: 'A task holds the checkout. Wait for it to finish.',
  plan_merge: 'Finish the open plan merge first.',
  project_state_questions: 'Answer the project state questions before saving.',
  invalid_request: 'The save request was not accepted.',
  record_absent: 'No project state record is available to save.',
  record_unreadable: 'The project state record could not be read.',
  record_refused: 'The project state record could not be accepted.',
  render_context_refused: 'The repository configuration could not be rendered.',
  checkout_changed: 'The checkout changed during the save. Refresh and try again.',
  projections_changing:
    'The Haive files kept changing during the save. Try again once they settle.',
  plan_mirror_held: 'The plan snapshot could not be written. Check its pending write below.',
  integration_refused: 'The remote changes could not be integrated into this checkout.',
  resync_failed: 'The Haive files could not be refreshed after integrating remote changes.',
  integration_held: 'Tasks hold the checkout needed to integrate remote changes.',
  unowned_malformed_rtk: 'An RTK record file needs manual repair before it can be saved.',
  projection_not_owned: 'A changed file could not be recognized as Haive data.',
  projection_rewritten: 'A file changed during the save. Refresh and try again.',
};

function Reason({ reason }: { reason: HaiveDataRefusal }) {
  return (
    <div className="min-w-0 space-y-1">
      <MarkdownView body={reasons[reason.code]} />
      <code className="break-all text-xs text-neutral-400">{reason.code}</code>
      {'file' in reason && reason.file && <FileList paths={[reason.file]} />}
      {'units' in reason && <FileList paths={reason.units} />}
      {'count' in reason && <MarkdownView body={`${reason.count} tasks hold the checkout.`} />}
      {'taskIds' in reason && reason.taskIds.map((id) => <TaskLink key={id} id={id} />)}
      {'taskId' in reason && <TaskLink id={reason.taskId} />}
    </div>
  );
}

function TaskLink({ id }: { id: string }) {
  return (
    <Link
      className="block break-all text-sm text-indigo-300 hover:underline"
      href={`/tasks/${encodeURIComponent(id)}`}
    >
      Open task {id}
    </Link>
  );
}

function FileList({ paths }: { paths: string[] }) {
  return (
    <ul className="space-y-1 text-xs text-neutral-300">
      {paths.map((path) => (
        <li key={path}>
          <code className="break-all">{path}</code>
        </li>
      ))}
    </ul>
  );
}

function SaveResult({
  result,
  repositoryId,
}: {
  result: HaiveDataSaveResult;
  repositoryId: string;
}) {
  const title = {
    saved: 'Save completed',
    unchanged: 'No new commit needed',
    refused: 'Save refused',
    conflict: 'Remote merge needs attention',
    failed: 'Save did not complete',
  }[result.outcome];
  return (
    <Card
      role={['failed', 'refused', 'conflict'].includes(result.outcome) ? 'alert' : 'status'}
      className="min-w-0 space-y-3"
    >
      <h2 className="font-semibold">{title}</h2>
      <MarkdownView
        body={`${result.committed ? 'Committed' : 'No new commit'}. ${result.pushed ? 'Pushed to origin.' : 'Not pushed by this action.'}`}
      />
      {result.commitSha && <code className="block break-all text-xs">{result.commitSha}</code>}
      {result.branch && (
        <div className="text-sm text-neutral-400">
          Branch: <code className="break-all">{result.branch}</code>
        </div>
      )}
      {result.refusal && <Reason reason={result.refusal} />}
      {result.failure && (
        <>
          <MarkdownView body="The operation failed. Refresh the status and retry when the cause is resolved." />
          <code>{result.failure.code}</code>
        </>
      )}
      {!result.indexSynced && (
        <MarkdownView body="The Git index could not be synchronized. Check staged changes before committing other work." />
      )}
      {result.files.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm">Saved files ({result.files.length})</summary>
          <FileList paths={result.files} />
        </details>
      )}
      {result.skipped.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Skipped files</h3>
          <MarkdownView body="These files were left out of the save." />
          <FileList paths={result.skipped} />
        </div>
      )}
      {result.conflict && (
        <div className="space-y-2">
          <MarkdownView
            body={
              result.conflict.unrelated
                ? 'The local and remote branches have unrelated histories. Resolve their merge from the Plan page, then retry.'
                : 'Resolve the remote merge from the Plan page, then retry.'
            }
          />
          <FileList paths={result.conflict.paths} />
          {result.conflict.autoResolved.length > 0 && (
            <details>
              <summary>Automatically resolved files</summary>
              <FileList paths={result.conflict.autoResolved} />
            </details>
          )}
          <Link
            href={`/repos/${encodeURIComponent(repositoryId)}/plan`}
            className="text-sm text-indigo-300 hover:underline"
          >
            Open Plan
          </Link>
        </div>
      )}
    </Card>
  );
}

/** Key this component by repository id so a late save cannot display on another repository. */
export function HaiveDataPanel({ repositoryId }: { repositoryId: string }) {
  const [status, setStatus] = useState<HaiveDataStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<HaiveDataSaveResult | null>(null);
  const [saving, setSaving] = useState<'save' | 'push' | null>(null);
  const [refresh, setRefresh] = useState(0);
  const busy = useRef(false);
  const base = `/repos/${encodeURIComponent(repositoryId)}/haive-data`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const data = await api.get<HaiveDataStatus>(base, controller.signal);
        if (controller.signal.aborted) return;
        setStatus(data);
        setLoadError(null);
      } catch (err) {
        if (!controller.signal.aborted)
          setLoadError(err instanceof Error ? err.message : 'Could not load Haive data');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void read(), 5_000);
        }
      }
    }
    if (!saving) void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, refresh, saving]);

  const reload = () => {
    setLoading(true);
    setRefresh((n) => n + 1);
  };
  async function save(push: boolean) {
    if (busy.current) return;
    busy.current = true;
    setSaving(push ? 'push' : 'save');
    setResult(null);
    setSaveError(null);
    try {
      // An absent body is invalid JSON; the default Save deliberately sends {}.
      setResult(await api.post<HaiveDataSaveResult>(`${base}/save`, push ? { push: true } : {}));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save Haive data');
    } finally {
      reload();
      setSaving(null);
      busy.current = false;
    }
  }
  const disabled = loading || !status || !!loadError || saving !== null;
  const changed = status?.files?.filter((file) => file.change !== 'unchanged').length;

  return (
    <div className="min-w-0 space-y-5">
      <Card className="min-w-0 space-y-4">
        <MarkdownView body="Save writes the current project state record and plan snapshot, then commits recognized Haive files. Unknown files may be skipped. Save & push also integrates remote changes and pushes the current branch, including its existing commits." />
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled || !!status?.holds.save.length}
            onClick={() => void save(false)}
          >
            Save
          </Button>
          <Button
            disabled={disabled || !!status?.holds.push.length}
            onClick={() => void save(true)}
          >
            Save &amp; push
          </Button>
          <Button variant="secondary" disabled={loading || saving !== null} onClick={reload}>
            Refresh
          </Button>
        </div>
        {saving && (
          <div role="status">
            <MarkdownView
              body={
                saving === 'push'
                  ? 'Saving and pushing… Waiting for the worker to finish.'
                  : 'Saving… Waiting for the worker to finish.'
              }
            />
          </div>
        )}
        {loading && !saving && (
          <div role="status">
            <MarkdownView body="Loading Haive data…" />
          </div>
        )}
        {loadError && (
          <div role="alert">
            <MarkdownView body={`Could not refresh status. ${loadError}`} />
          </div>
        )}
        {saveError && (
          <div role="alert">
            <MarkdownView body={saveError} />
          </div>
        )}
        {status && (
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            {(['save', 'push'] as const).map(
              (action) =>
                status.holds[action].length > 0 && (
                  <div key={action} className="min-w-0 rounded border border-amber-800 p-3">
                    <h2 className="mb-2 text-sm font-semibold">
                      {action === 'save' ? 'Save held' : 'Save & push held'}
                    </h2>
                    <div className="space-y-3">
                      {status.holds[action].map((reason) => (
                        <Reason key={reason.code} reason={reason} />
                      ))}
                    </div>
                  </div>
                ),
            )}
          </div>
        )}
      </Card>
      {result && <SaveResult result={result} repositoryId={repositoryId} />}
      {status && (
        <>
          <Card className="min-w-0 space-y-3">
            <h2 className="font-semibold">Written to checkout</h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-neutral-500">Checkout</dt>
                <dd>{status.checkout}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-neutral-500">Branch</dt>
                <dd className="break-all">{status.branch ?? 'Unknown or detached'}</dd>
              </div>
              <div>
                <dt className="text-neutral-500">Project record</dt>
                <dd>
                  {status.record.writePending
                    ? 'Write pending recovery'
                    : status.record.dirty
                      ? 'Write pending'
                      : 'No pending write'}
                </dd>
              </div>
              <div>
                <dt className="text-neutral-500">Plan snapshot</dt>
                <dd>{status.snapshot.dirty ? 'Write pending' : 'No pending write'}</dd>
              </div>
            </dl>
            {(status.record.dirty || status.record.writePending) && (
              <div role="status">
                <MarkdownView body="The project state record has a pending write. Save will try to flush it once any holds clear." />
                {status.record.lastError && <MarkdownView body={status.record.lastError} />}
                {status.record.syncError && <MarkdownView body={status.record.syncError} />}
              </div>
            )}
            {status.snapshot.dirty && (
              <div role="status">
                <MarkdownView body="The plan snapshot has a pending write." />
                {status.snapshot.lastError && <MarkdownView body={status.snapshot.lastError} />}
              </div>
            )}
          </Card>
          <Card className="min-w-0 space-y-3">
            <h2 className="font-semibold">Commit state</h2>
            <MarkdownView
              body={
                status.files === null
                  ? 'File status unavailable. Refresh to try again.'
                  : status.files.length === 0
                    ? 'No Haive projection files were found.'
                    : changed
                      ? `${changed} files differ from HEAD. The list includes files Save may skip.`
                      : 'Listed files match HEAD. This does not confirm that they have been pushed.'
              }
            />
            {status.files && status.files.length > 0 && (
              <ul className="divide-y divide-neutral-800">
                {status.files.map((file) => (
                  <li
                    key={file.path}
                    className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <code className="min-w-0 break-all text-xs">{file.path}</code>
                    <span className="shrink-0 text-xs text-neutral-400">
                      {file.change}
                      {file.staged ? ' · staged' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h2 className="mb-2 font-semibold">Pushed to origin</h2>
            <MarkdownView body="Push status is reported for the latest save action on this page. A file matching HEAD alone does not prove it is on origin." />
          </Card>
        </>
      )}
      <ProjectStateConflictsBanner
        repositoryId={repositoryId}
        onAnswered={reload}
        pollMs={10_000}
      />
      <ProjectStateConflictsBanner
        repositoryId={repositoryId}
        scope="plan"
        onAnswered={reload}
        pollMs={10_000}
      />
    </div>
  );
}
