'use client';

import { Button } from '@/components/ui';
import type { ModuleDiffRow } from '@haive/shared/modularity';

export function ModuleActiveCell({
  row,
  busy,
  onToggle,
}: {
  row: Pick<ModuleDiffRow, 'id' | 'rowVersion' | 'deactivatedAt'>;
  busy: boolean;
  onToggle: () => void;
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
    </div>
  );
}
