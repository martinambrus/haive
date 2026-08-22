'use client';

import type { ReactNode } from 'react';
import type { CliProvider } from '@/lib/api-client';

/** A loop role or a fan-out seat: the addressable slot a CLI choice attaches to. */
type CliSlot = { id: string; label: string };

/** The CLI + effort dropdowns for ONE step: a single "CLI" pair, or one pair per loop
 *  role (Tester/Fixer, Reviewer/Corrector) when the step declares them, plus one pair per
 *  fan-out seat (08c's lenses, 08d's adversaries).
 *
 *  Shared by the step card and the task page's CLIs tab, which offers the same choice for
 *  a step the run has not reached yet (no task_steps row, so no card). Two copies of this
 *  grid would let the two surfaces disagree about what a step's CLI choice looks like. */
export function CliPickerGrid({
  providers,
  idPrefix,
  roles,
  seats,
  defaultProviderId,
  defaultEffortLevel,
  roleProviders,
  roleEfforts,
  seatProviders,
  seatEfforts,
  taskCliProviderId,
  locked = false,
  busy = false,
  onChange,
}: {
  providers: CliProvider[];
  /** Prefix for the generated input ids/labels; must be unique per rendered step. */
  idPrefix: string;
  roles?: readonly CliSlot[];
  seats?: readonly CliSlot[];
  /** Effective provider for the single-CLI dropdown (per-step pref, else task default). */
  defaultProviderId: string;
  defaultEffortLevel?: string | null;
  roleProviders?: Record<string, string | null>;
  roleEfforts?: Record<string, string | null>;
  seatProviders?: Record<string, string | null>;
  seatEfforts?: Record<string, string | null>;
  taskCliProviderId: string | null;
  locked?: boolean;
  busy?: boolean;
  onChange: (cliProviderId: string | null, role?: string, effortLevel?: string) => void;
}) {
  // Fixed widths, deliberately not intrinsic or flex-1: a native <select> sizes itself to
  // its widest option, so self-sizing controls re-laid-out the whole (wrapping) picker row
  // on every CLI switch. One width for the CLI dropdowns, one for the effort dropdowns,
  // so the default row and the per-role/per-seat rows line up as columns.
  const cliSelectBase =
    'h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';
  const cliSelectClass = `${cliSelectBase} w-60`;
  const effortSelectClass = `${cliSelectBase} w-24`;
  // Label sits ABOVE its dropdowns, not beside them. Beside, the labels have to share one
  // fixed-width column or the dropdowns go ragged — and that column is as wide as the
  // longest label ("Security Code Reviewer", 143px), which strands a short one ("CLI",
  // 19px) far from its own control however it is aligned inside it. Stacked, every
  // dropdown starts at its column's left edge with nothing between it and its label, no
  // label is ever truncated, and the cell narrows to 22rem so more fit per row.
  const cliLabelClass = 'truncate text-xs font-medium text-neutral-400';
  const cliOptions = (
    <>
      <option value="">(none — deterministic only)</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id} disabled={!p.enabled}>
          {p.label} ({p.name}){!p.enabled ? ' — disabled' : ''}
        </option>
      ))}
    </>
  );

  // Per-step effort dropdown: given the effective provider for a (step, role) and the
  // remembered effort, render a select of that CLI's effort scale. A CLI change clears
  // the stored effort server-side, so this re-derives its options + selected value from
  // the NEW provider (claude 'max' drops on a switch to codex, which exposes 'ultra').
  //
  // A CLI with no effort knob (effortScale === null — gemini, amp, antigravity, grok)
  // renders a DISABLED placeholder rather than nothing: returning null collapsed the
  // control, so switching to one of those four shifted every dropdown after it. Reserving
  // the slot keeps the row geometry identical across every provider.
  const effortSelectFor = (
    providerId: string,
    rememberedEffort: string | null | undefined,
    roleId?: string,
  ): ReactNode => {
    const prov = providers.find((p) => p.id === providerId);
    const scale = prov?.effortScale ?? null;
    if (!scale)
      return (
        <select
          aria-label="reasoning effort"
          title={
            prov
              ? `${prov.label} has no reasoning/effort setting`
              : 'No reasoning/effort setting for this CLI'
          }
          disabled
          defaultValue=""
          className={effortSelectClass}
        >
          <option value="">—</option>
        </select>
      );
    const value = rememberedEffort ?? prov?.effortLevel ?? scale.max;
    return (
      <select
        aria-label="reasoning effort"
        title="Reasoning/effort level for this step's CLI (overrides the CLI's default)"
        disabled={locked || busy}
        value={value}
        onChange={(e) => void onChange(providerId || null, roleId, e.target.value)}
        className={effortSelectClass}
      >
        {scale.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  };

  return (
    /* One grid cell per picker, each cell laid out label | CLI | effort at fixed
       widths, so the three columns line up across every row instead of each
       picker starting wherever the previous label happened to end. auto-fill
       drops cells per row as the window narrows; the cell width never changes,
       so nothing re-flows on a CLI switch. */
    <div className="grid gap-x-4 gap-y-2 [grid-template-columns:repeat(auto-fill,minmax(22rem,1fr))]">
      {roles && roles.length > 0 ? (
        // Multi-CLI step (e.g. spec-quality): one dropdown per role.
        roles.map((roleDesc) => (
          <div key={roleDesc.id} className="flex flex-col gap-1">
            <label htmlFor={`${idPrefix}-${roleDesc.id}`} className={cliLabelClass}>
              {roleDesc.label}
            </label>
            <div className="flex items-center gap-2">
              <select
                id={`${idPrefix}-${roleDesc.id}`}
                disabled={locked || busy}
                value={roleProviders?.[roleDesc.id] ?? taskCliProviderId ?? ''}
                onChange={(e) => void onChange(e.target.value || null, roleDesc.id)}
                className={cliSelectClass}
              >
                {cliOptions}
              </select>
              {effortSelectFor(
                roleProviders?.[roleDesc.id] ?? taskCliProviderId ?? '',
                roleEfforts?.[roleDesc.id],
                roleDesc.id,
              )}
            </div>
          </div>
        ))
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={idPrefix} className={cliLabelClass}>
            CLI
          </label>
          <div className="flex items-center gap-2">
            <select
              id={idPrefix}
              disabled={locked || busy}
              value={defaultProviderId}
              onChange={(e) => void onChange(e.target.value || null)}
              className={cliSelectClass}
            >
              {cliOptions}
            </select>
            {effortSelectFor(defaultProviderId, defaultEffortLevel)}
          </div>
        </div>
      )}
      {/* Fan-out steps (08c, 08d) keep the single CLI dropdown above as the step-wide
          default — an unset seat falls through to it — and add one dropdown per SEAT,
          so each reviewer, adversary or refutation lens can answer on a different
          model. Rendered alongside rather than instead of the default, and separate
          from cliRoles, whose presence drives loop round badges and Resume. */}
      {seats?.map((seat) => (
        <div key={seat.id} className="flex flex-col gap-1">
          <label htmlFor={`${idPrefix}-seat-${seat.id}`} className={cliLabelClass}>
            {seat.label}
          </label>
          <div className="flex items-center gap-2">
            <select
              id={`${idPrefix}-seat-${seat.id}`}
              disabled={locked || busy}
              value={seatProviders?.[seat.id] ?? ''}
              onChange={(e) => void onChange(e.target.value || null, seat.id)}
              className={cliSelectClass}
            >
              <option value="">(step default)</option>
              {cliOptions}
            </select>
            {effortSelectFor(seatProviders?.[seat.id] ?? '', seatEfforts?.[seat.id], seat.id)}
          </div>
        </div>
      ))}
    </div>
  );
}
