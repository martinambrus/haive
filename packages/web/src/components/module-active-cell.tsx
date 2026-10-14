'use client';

import { Button } from '@/components/ui';
import type { ModuleDiffRow } from '@haive/shared/modularity';

export function ModuleActiveCell({
  row,
  busy,
  onToggle,
  onTeardown,
  onPurge,
}: {
  row: Pick<
    ModuleDiffRow,
    'id' | 'rowVersion' | 'deactivatedAt' | 'state' | 'tornDownAt' | 'missingAt'
  >;
  busy: boolean;
  onToggle: () => void;
  onTeardown: () => void;
  onPurge: () => void;
}) {
  if (row.rowVersion === null) return <span className="text-neutral-500">—</span>;
  const since = row.deactivatedAt;
  const action = since === null ? 'Deactivate' : 'Activate';
  return (
    <div className="flex flex-col items-start gap-2">
      <span className={since === null ? 'text-emerald-300' : 'text-amber-300'}>
        {since === null ? 'Active' : `Deactivated since ${new Date(since).toLocaleString()}`}
      </span>
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
