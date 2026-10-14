'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button } from '@/components/ui';
import { guardLeaving } from './unsaved-changes-guard';

/** While `dirty`, a reload or closed tab asks the browser to confirm and a click on an in-app link
 *  asks first; back and forward are not covered. Render what it returns. */
export function useUnsavedChangesGuard(dirty: boolean): ReactNode {
  const router = useRouter();
  const [leavingTo, setLeavingTo] = useState<string | null>(null);

  useEffect(() => (dirty ? guardLeaving(window, setLeavingTo) : undefined), [dirty]);

  function discard() {
    if (leavingTo === null) return;
    setLeavingTo(null);
    router.push(leavingTo);
  }

  return (
    <Dialog open={leavingTo !== null} onOpenChange={(open) => !open && setLeavingTo(null)}>
      <DialogContent role="alertdialog" aria-labelledby="unsaved-changes-title">
        <DialogHeader>
          <DialogTitle id="unsaved-changes-title">Discard unsaved changes?</DialogTitle>
          <InlineMarkdown
            className="text-sm text-neutral-300"
            body="Your changes have not been saved. Leaving this page discards them."
          />
        </DialogHeader>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            autoFocus
            onClick={() => setLeavingTo(null)}
          >
            Keep editing
          </Button>
          <Button type="button" variant="destructive" className="h-11" onClick={discard}>
            Discard
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
