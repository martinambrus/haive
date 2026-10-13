'use client';

import { useState } from 'react';
import { deleteTaskType, type ApiError } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';

interface TaskTypeDeleteDialogProps {
  slug: string | null;
  displayName: string;
  onClose: () => void;
  onDeleted: (slug: string) => void;
}

export function TaskTypeDeleteDialog({
  slug,
  displayName,
  onClose,
  onDeleted,
}: TaskTypeDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    setError(null);
    onClose();
  }

  async function confirm() {
    if (!slug) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteTaskType(slug);
      onDeleted(slug);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to delete the task type');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog open={slug !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent role="alertdialog" aria-labelledby="delete-task-type-title">
        <DialogHeader>
          <DialogTitle id="delete-task-type-title">Delete task type</DialogTitle>
          <p className="text-sm text-neutral-300">
            {`Delete "${displayName}"? This cannot be undone. A type that tasks already use cannot be deleted; disable it instead.`}
          </p>
        </DialogHeader>
        <FormError message={error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="secondary" className="h-11" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11"
            disabled={deleting}
            onClick={() => void confirm()}
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
