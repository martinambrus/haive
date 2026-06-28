'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  API_BASE_URL,
  deleteTaskAttachment,
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

/** Task attachments tab: list, upload and remove user-supplied reference files the
 *  AI agent reads from the task workspace. Works for new and running tasks alike. */
export function AttachmentsPanel({ taskId }: { taskId: string }) {
  const [items, setItems] = useState<TaskAttachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  async function onPick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of Array.from(files)) await uploadTaskAttachment(taskId, f);
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Upload failed');
    } finally {
      setUploading(false);
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

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3 p-4">
        <div>
          <h2 className="text-sm font-medium text-neutral-100">Attachments</h2>
          <p className="text-xs text-neutral-500">
            Reference files (docs, screenshots, sample data) the AI agent can read while it works.
            Stored in the task workspace under .haive/task-uploads/.
          </p>
        </div>
        <div>
          <input
            type="file"
            multiple
            disabled={uploading}
            onChange={(e) => {
              void onPick(e.target.files);
              e.target.value = '';
            }}
            className="block w-full text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-indigo-500"
          />
          {uploading && <p className="mt-1 text-xs text-indigo-300">Uploading…</p>}
        </div>
        {error && <p className="text-xs text-rose-400">{error}</p>}
      </Card>

      {items && items.length === 0 && (
        <div className="text-sm text-neutral-500">No attachments yet.</div>
      )}

      {items && items.length > 0 && (
        <div className="flex flex-col gap-2">
          {items.map((a) => (
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
                {a.description && (
                  <p className="truncate text-xs text-neutral-400">{a.description}</p>
                )}
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
          ))}
        </div>
      )}
    </div>
  );
}
