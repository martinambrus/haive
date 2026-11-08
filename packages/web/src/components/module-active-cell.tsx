'use client';

import { Badge, Button } from '@/components/ui';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import type { ModuleDiffRow } from '@haive/shared/modularity';

export function ModuleActiveCell({
  row,
  busy,
  onToggle,
  onTeardown,
  onPurge,
  onCancelDrain,
  onRetry,
}: {
  row: Pick<
    ModuleDiffRow,
    | 'id'
    | 'rowVersion'
    | 'deactivatedAt'
    | 'state'
    | 'tornDownAt'
    | 'missingAt'
    | 'drainingAt'
    | 'runtime'
  >;
  busy: boolean;
  onToggle: () => void;
  onTeardown: () => void;
  onPurge: () => void;
  onCancelDrain?: () => void;
  onRetry?: () => void;
}) {
  if (row.rowVersion === null) return <span className="text-neutral-500">—</span>;
  const since = row.deactivatedAt;
  const draining = since === null && row.drainingAt != null;
  const runtime = since === null && row.runtime?.state !== 'ready' ? row.runtime : undefined;
  const action = draining ? 'View dependents' : since === null ? 'Deactivate' : 'Activate';
  return (
    <div className="flex flex-col items-start gap-2">
      <span className={since === null ? 'text-emerald-300' : 'text-amber-300'}>
        {draining
          ? `Draining since ${new Date(row.drainingAt!).toLocaleString()}`
          : since === null
            ? 'Active'
            : `Deactivated since ${new Date(since).toLocaleString()}`}
      </span>
      {runtime && (
        <Badge variant={runtime.state === 'failed' ? 'error' : 'warning'}>
          {runtime.state === 'failed' ? 'Failed' : 'Starting'}
        </Badge>
      )}
      {runtime && runtime.reason !== null && (
        <InlineMarkdown body={runtime.reason} className="max-w-xs text-xs text-neutral-400" />
      )}
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy}
        aria-label={`${action} ${row.id}`}
        onClick={onToggle}
      >
        {action}
      </Button>
      {runtime?.state === 'failed' && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          aria-label={`Retry ${row.id}`}
          onClick={onRetry}
        >
          Retry
        </Button>
      )}
      {draining && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onCancelDrain}
          aria-label={`Cancel drain ${row.id}`}
        >
          Cancel drain
        </Button>
      )}
      {since !== null && row.tornDownAt !== null && (
        <span className="text-neutral-400">
          {`Torn down ${new Date(row.tornDownAt).toLocaleString()}`}
        </span>
      )}
      {since !== null && row.tornDownAt === null && row.state === 'loaded' && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          aria-label={`Tear down ${row.id}`}
          onClick={onTeardown}
        >
          Tear down
        </Button>
      )}
      {row.state === 'missing' && row.missingAt !== null && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy}
          aria-label={`Purge data of ${row.id}`}
          onClick={onPurge}
        >
          Purge data…
        </Button>
      )}
    </div>
  );
}
