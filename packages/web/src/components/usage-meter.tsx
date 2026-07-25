'use client';

import type { UsageWindow, UsageWindowSnapshot } from '@/lib/api-client';
import { resetShort, resetSuffix } from '@/lib/usage-format';

/** Shared rendering for a subscription usage meter. Two callers with different scopes —
 *  the task header chip (the CLI the current step runs on) and the task-list strip (every
 *  subscription the visible rows use) — draw the SAME bars, so the bars live here and each
 *  caller keeps only its own selection logic and wrapper. */

/** Per-window remaining-% colour (claude-hud scheme): green >25% left, amber 10-25%
 *  (75-90% used), red <=10% (>=90% used). Each window is coloured on its own value. */
export function usageRemainingColor(remaining: number): string {
  return remaining <= 10 ? 'text-red-400' : remaining <= 25 ? 'text-amber-400' : 'text-emerald-400';
}

/** Progress-bar fill colour for the usage chip, same thresholds as usageRemainingColor. */
export function usageBarColor(remaining: number): string {
  return remaining <= 10 ? 'bg-red-500' : remaining <= 25 ? 'bg-amber-500' : 'bg-emerald-500';
}

export interface MeterWindow {
  label: string;
  w: UsageWindow;
}

/** The windows a snapshot exposes, in display order. Empty when the vendor reports none. */
export function usageWindowsOf(snap: UsageWindowSnapshot): MeterWindow[] {
  const windows: MeterWindow[] = [];
  if (snap.fiveHour) windows.push({ label: '5h', w: snap.fiveHour });
  if (snap.sevenDay) windows.push({ label: 'week', w: snap.sevenDay });
  if (snap.daily) windows.push({ label: 'day', w: snap.daily });
  return windows;
}

/** `5h: 8% left (resets 19:30) · week: 61% left` — the hover text for a meter. */
export function usageTooltip(windows: readonly MeterWindow[], now: number): string {
  return windows
    .map((x) => `${x.label}: ${100 - x.w.usedPct}% left${resetSuffix(x.w.resetsAt, now)}`)
    .join('   ·   ');
}

/** Provider name followed by one filled bar per window. Presentation only — the caller
 *  decides which snapshot this is and owns the surrounding layout. */
export function UsageBars({
  name,
  windows,
  now,
}: {
  name: string;
  windows: readonly MeterWindow[];
  now: number;
}) {
  return (
    <>
      <span className="text-neutral-400">{name}</span>
      {windows.map((x, i) => {
        const remaining = 100 - x.w.usedPct;
        const reset = resetShort(x.w.resetsAt, now);
        return (
          <span key={x.label} className="flex items-center gap-1.5">
            {i > 0 && <span className="h-3 w-px bg-neutral-600" aria-hidden />}
            <span className="relative h-3.5 w-[50px] shrink-0 overflow-hidden rounded-sm bg-neutral-800 ring-1 ring-white/70">
              <span
                className={`absolute inset-y-0 left-0 ${usageBarColor(remaining)}`}
                style={{ width: `${Math.max(0, Math.min(100, remaining))}%` }}
                aria-hidden
              />
              <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold leading-none text-neutral-50 [text-shadow:0_0_2px_#000,0_1px_1px_#000]">
                {remaining}%
              </span>
            </span>
            {reset && <span className="text-neutral-400">{reset}</span>}
          </span>
        );
      })}
    </>
  );
}
