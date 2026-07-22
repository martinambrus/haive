'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { UpgradeGroup } from '@/components/cli-upgrade-selection';

const quickBtn =
  'rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:border-indigo-700 hover:bg-indigo-950 disabled:opacity-50';

type CheckState = 'checked' | 'unchecked' | 'indeterminate';

function groupState(g: UpgradeGroup, selected: Set<string>): CheckState {
  const picked = g.rows.filter((r) => selected.has(r.id)).length;
  if (picked === 0) return 'unchecked';
  if (picked === g.rows.length) return 'checked';
  return 'indeterminate';
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
      viewBox="0 0 12 12"
      fill="currentColor"
    >
      <path d="M4 2l4 4-4 4z" />
    </svg>
  );
}

interface CliUpgradeAllProps {
  groups: UpgradeGroup[];
  onUpgrade: (providerIds: string[]) => void;
  busy: boolean;
  progress: string | null;
}

/** Bulk upgrade control for the CLI providers list: a checkbox popover over the
 *  CLI types that have a pending version upgrade, each expandable to its
 *  individual provider rows so clones of the same CLI can be picked apart. */
export function CliUpgradeAll({ groups, onUpgrade, busy, progress }: CliUpgradeAllProps) {
  const allIds = useMemo(() => groups.flatMap((g) => g.rows.map((r) => r.id)), [groups]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allIds));
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Re-seed to "everything" whenever the upgradable set changes: a completed
  // upgrade removes rows, and an id left behind in the set would make the footer
  // count over-report. Keyed on the id list rather than the array identity so a
  // parent that rebuilds `groups` each render cannot loop this effect.
  const idsKey = allIds.join('|');
  useEffect(() => {
    setSelected(new Set(idsKey ? idsKey.split('|') : []));
  }, [idsKey]);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (groups.length === 0) return null;

  function toggleGroup(g: UpgradeGroup) {
    const checked = groupState(g, selected) === 'checked';
    const next = new Set(selected);
    for (const r of g.rows) {
      if (checked) next.delete(r.id);
      else next.add(r.id);
    }
    setSelected(next);
  }

  function toggleRow(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleExpand(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const selectedCount = selected.size;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative flex items-center gap-2" ref={panelRef}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          disabled={busy}
        >
          Upgrade All
          <span className="text-xs text-neutral-400">
            {selectedCount} of {allIds.length}
          </span>
          <Chevron open={open} />
        </Button>
        <Button
          size="sm"
          onClick={() => onUpgrade([...selected])}
          disabled={busy || selectedCount === 0}
          title="Pin the newest version on every selected provider and rebuild its sandbox image"
        >
          {busy ? (progress ?? 'Upgrading...') : `Upgrade ${selectedCount}`}
        </Button>

        {open && (
          <div className="absolute left-0 top-full z-20 mt-1 max-h-96 w-[34rem] max-w-[calc(100vw-3rem)] overflow-auto rounded border border-neutral-700 bg-neutral-900 p-2 shadow-lg">
            <div className="mb-2 flex gap-2">
              <button
                type="button"
                className={quickBtn}
                onClick={() => setSelected(new Set(allIds))}
                disabled={selectedCount === allIds.length}
              >
                Select all ({allIds.length})
              </button>
              <button
                type="button"
                className={quickBtn}
                onClick={() => setSelected(new Set())}
                disabled={selectedCount === 0}
              >
                Deselect all
              </button>
            </div>

            {groups.map((g) => {
              const state = groupState(g, selected);
              const isExpanded = expanded.has(g.name);
              // A type with a single provider has nothing to expand into, so it
              // shows its version jump inline instead of a row count.
              const single = g.rows.length === 1 ? g.rows[0]! : null;
              return (
                <div key={g.name} className="flex flex-col">
                  <div
                    className="flex items-center gap-1.5 rounded px-1 py-1 hover:bg-neutral-800/60"
                    title={
                      single
                        ? `${g.name}: ${single.label} (${single.from} → ${single.to})`
                        : `${g.name}: ${g.rows.length} providers`
                    }
                  >
                    {single ? (
                      <span className="w-5 shrink-0" />
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleExpand(g.name)}
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${g.name} providers`}
                        className="flex h-5 w-5 shrink-0 items-center justify-center text-neutral-500 hover:text-neutral-300"
                      >
                        <Chevron open={isExpanded} />
                      </button>
                    )}
                    <input
                      type="checkbox"
                      checked={state === 'checked'}
                      ref={(el) => {
                        if (el) el.indeterminate = state === 'indeterminate';
                      }}
                      onChange={() => toggleGroup(g)}
                      className="shrink-0"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                      {g.name}
                    </span>
                    <span className="ml-auto max-w-[50%] shrink-0 truncate pl-2 font-mono text-[11px] text-neutral-500">
                      {single ? `${single.from} → ${single.to}` : `${g.rows.length} rows`}
                    </span>
                  </div>

                  {!single &&
                    isExpanded &&
                    g.rows.map((r) => (
                      <label
                        key={r.id}
                        className="flex items-center gap-1.5 rounded py-1 pl-7 pr-1 hover:bg-neutral-800/60"
                        title={`${r.label} (${r.from} → ${r.to})`}
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleRow(r.id)}
                          className="shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate text-sm text-neutral-300">
                          {r.label}
                        </span>
                        <span className="ml-auto max-w-[50%] shrink-0 truncate pl-2 font-mono text-[11px] text-neutral-500">
                          {r.from} → {r.to}
                        </span>
                      </label>
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <p className="text-xs text-neutral-500">
        Each upgrade queues a sandbox image rebuild on the shared CLI queue — rebuilds run behind
        any agent work already in flight.
      </p>
    </div>
  );
}
