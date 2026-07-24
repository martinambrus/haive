/** Display helpers for subscription usage windows, shared by the task-header chip
 *  (HeaderUsageChip) and the depletion notifier (notifications/usage-alerts). Pure
 *  formatting only — no DOM, no fetching — so both surfaces name providers and phrase
 *  reset times identically. */

import type { CliProviderName } from '@/lib/api-client';

// Short display names for the usage chip (the CLI "type", not the user's clone label).
export const CLI_USAGE_LABEL: Partial<Record<CliProviderName, string>> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  zai: 'Z.ai',
};

export function resetSuffix(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return ' (resetting)';
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return d > 0 ? ` (resets in ${d}d ${h}h)` : ` (resets in ${h}h ${m}m)`;
}

/** Compact time-to-reset for the inline chip (the verbose form lives in the tooltip):
 *  "46m", "3h 20m", "2d 4h", or "now". Empty when the window carries no reset time. */
export function resetShort(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
