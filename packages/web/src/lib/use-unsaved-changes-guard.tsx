'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { Button } from '@/components/ui';
import { guardLeaving, leaveThrough, type Leaving } from './unsaved-changes-guard';

/** While `dirty`, a reload or closed tab asks the browser to confirm and a click on an in-app link
 *  asks first; back and forward are not covered. Render what it returns. */
export function useUnsavedChangesGuard(dirty: boolean): ReactNode {
  const router = useRouter();
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const release = useRef<() => void>(() => {});

  useEffect(() => {
    if (!dirty) return undefined;
    const stop = guardLeaving(window, setLeaving);
    release.current = stop;
    return () => {
      stop();
      release.current = () => {};
    };
  }, [dirty]);

  function discard() {
    if (leaving === null) return;
    setLeaving(null);
    leaveThrough(leaving, release.current, (path) => router.push(path));
  }

  return (
    <Dialog open={leaving !== null} onOpenChange={(open) => !open && setLeaving(null)}>
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
            onClick={() => setLeaving(null)}
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
