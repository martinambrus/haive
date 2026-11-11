import { Dialog } from '@/components/dialog';
import { Button, Card } from '@/components/ui';

export function PostLoginRetryDialog({
  stepId,
  onClose,
  onRetry,
}: {
  stepId: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  return (
    <Dialog
      open={stepId !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      aria-label="Login successful"
      className="w-[calc(100vw-2rem)] max-w-md"
      backdropClassName="bg-black/70 backdrop-blur-none"
    >
      <Card className="flex flex-col gap-4 p-5">
        <h2 className="text-base font-semibold text-neutral-100">Login successful</h2>
        <p className="text-sm text-neutral-300">
          You&apos;re now signed in. Retry step{' '}
          <span className="font-mono text-xs text-neutral-400">{stepId}</span> now?
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Not now
          </Button>
          <Button size="sm" onClick={onRetry}>
            Retry step
          </Button>
        </div>
      </Card>
    </Dialog>
  );
}
