'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { splitAttachmentPath } from '@haive/shared/attachments';
import {
  API_BASE_URL,
  attachmentUploadName,
  deleteTaskAttachment,
  deleteTaskAttachmentFolder,
  listTaskAttachments,
  uploadTaskAttachment,
  type TaskAttachment,
} from '@/lib/api-client';
import { Button, Card } from '@/components/ui';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Loose files first, then one group per TOP-LEVEL folder — that is the unit a
 *  user picked and the unit they remove. Nesting below it stays visible in each
 *  row's full path rather than becoming another level of chrome. */
function groupByFolder(items: TaskAttachment[]): {
  loose: TaskAttachment[];
  folders: { name: string; items: TaskAttachment[]; bytes: number }[];
} {
  const loose: TaskAttachment[] = [];
  const byTop = new Map<string, TaskAttachment[]>();
  for (const item of items) {
    const { dir } = splitAttachmentPath(item.filename);
    if (dir === '') {
      loose.push(item);
      continue;
    }
    const top = dir.split('/')[0] ?? dir;
    const bucket = byTop.get(top);
    if (bucket) bucket.push(item);
    else byTop.set(top, [item]);
  }
  return {
    loose,
    folders: [...byTop.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, group]) => ({
        name,
        items: group,
        bytes: group.reduce((sum, i) => sum + i.sizeBytes, 0),
      })),
  };
}

/** Task attachments tab: list, upload and remove user-supplied reference files the
 *  AI agent reads from the task workspace. Works for new and running tasks alike. */
export function AttachmentsPanel({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<TaskAttachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});

  const reload = useCallback(async () => {
    try {
      setItems(await listTaskAttachments(taskId));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load attachments');
    }
  }, [taskId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const grouped = useMemo(() => groupByFolder(items ?? []), [items]);

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    setError(null);
    try {
      for (const [index, f] of picked.entries()) {
        // Named progress rather than a boolean: a folder is one click and many
        // requests, and "Uploading…" for two minutes says nothing about where it is.
        setUploading(`${attachmentUploadName(f)} (${index + 1} of ${picked.length})`);
        await uploadTaskAttachment(taskId, f);
      }
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Upload failed');
      // Whatever landed before the failure is real and is now on the task.
      await reload();
    } finally {
      setUploading(null);
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Remove this attachment? The agent will no longer see it.')) return;
    setDeletingId(id);
    try {
      await deleteTaskAttachment(taskId, id);
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  async function onDeleteFolder(name: string, count: number) {
    if (!confirm(`Remove the folder "${name}" and all ${count} file(s) in it?`)) return;
    setDeletingId(name);
    try {
      await deleteTaskAttachmentFolder(taskId, name);
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  }

  const inputClass =
    'block w-full text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-indigo-500';

  function row(a: TaskAttachment) {
    return (
      <Card key={a.id} className="flex items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <a
            href={`${API_BASE_URL}/tasks/${taskId}/attachments/${a.id}/raw`}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-sm font-medium text-indigo-300 hover:underline"
          >
            {a.filename}
          </a>
          {a.description && <p className="truncate text-xs text-neutral-400">{a.description}</p>}
          <p className="text-[11px] text-neutral-500">
            {formatBytes(a.sizeBytes)} · {new Date(a.createdAt).toLocaleString()}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={deletingId === a.id}
          onClick={() => void onDelete(a.id)}
        >
          {deletingId === a.id ? 'Removing...' : 'Remove'}
        </Button>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-sm font-medium text-neutral-100">Attachments</h2>
          <p className="text-xs text-neutral-500">
            Reference files (docs, screenshots, sample data) the AI agent can read while it works.
            Stored in the task workspace under .haive/task-uploads/. A folder keeps its structure; a
            .zip, .tar or .tar.gz is expanded into its structure before the agent reads it.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-neutral-400">Files</p>
            <input
              type="file"
              multiple
              disabled={uploading !== null}
              onChange={(e) => {
                void onPick(e.target.files);
                e.target.value = '';
              }}
              className={inputClass}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-neutral-400">Folder</p>
            <input
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              disabled={uploading !== null}
              onChange={(e) => {
                void onPick(e.target.files);
                e.target.value = '';
              }}
              className={inputClass}
            />
          </div>
        </div>
        {uploading && <p className="text-xs text-indigo-300">Uploading {uploading}…</p>}
        {error && <p className="text-xs text-rose-400">{error}</p>}
      </Card>

      {items && items.length === 0 && (
        <div className="text-sm text-neutral-500">No attachments yet.</div>
      )}

      {grouped.loose.length > 0 && (
        <div className="flex flex-col gap-2">{grouped.loose.map(row)}</div>
      )}

      {grouped.folders.map((folder) => {
        const open = openFolders[folder.name] === true;
        return (
          <div key={folder.name} className="flex flex-col gap-2">
            <Card className="flex items-center justify-between gap-3 p-3">
              <button
                type="button"
                onClick={() => setOpenFolders((prev) => ({ ...prev, [folder.name]: !open }))}
                className="flex min-w-0 items-center gap-2 text-left"
              >
                {open ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-neutral-500" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-neutral-500" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-neutral-100">
                    {folder.name}/
                  </span>
                  <span className="text-[11px] text-neutral-500">
                    {folder.items.length} file(s) · {formatBytes(folder.bytes)}
                  </span>
                </span>
              </button>
              <Button
                size="sm"
                variant="secondary"
                disabled={deletingId === folder.name}
                onClick={() => void onDeleteFolder(folder.name, folder.items.length)}
              >
                {deletingId === folder.name ? 'Removing...' : 'Remove folder'}
              </Button>
            </Card>
            {open && <div className="flex flex-col gap-2 pl-6">{folder.items.map(row)}</div>}
          </div>
        );
      })}
    </div>
  );
}
