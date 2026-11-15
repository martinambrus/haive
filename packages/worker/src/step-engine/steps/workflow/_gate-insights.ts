import type { StatusSummaryItem } from '@haive/shared';
import { collapseToLine } from '../_untrusted-repo.js';
import type { Insight, LoadedInsight } from '@haive/shared/step';
export { loadUnactedInsights } from './_insight-loader.js';
import { code } from './_plan-ops.js';
import { asPlainText } from './_similar-sites.js';

export const INSIGHTS_AT_GATE = 30;
const INSIGHT_FIELD_CHARS = 200;

/** Persist only the legacy gate shape: bounded display fields, with the pre-filter parser id. */
export function gateInsights(
  insights: readonly (Insight & Pick<LoadedInsight, 'legacyId'>)[],
): Insight[] {
  const clip = (text: string): string => collapseToLine(text).slice(0, INSIGHT_FIELD_CHARS);
  return insights.map((i) => ({
    id: clip(i.legacyId ?? i.id),
    sourceStep: clip(i.sourceStep),
    title: clip(i.title),
    location: clip(i.location),
    description: clip(i.description),
  }));
}

/** The gate row listing them, or null when there are none. `nextStep` says what this gate lets
 *  the person do about them. */
export function insightsRow(
  insights: readonly Insight[],
  omitted: number,
  nextStep: string,
): StatusSummaryItem | null {
  if (insights.length === 0) return null;
  const total = insights.length + omitted;
  const clip = (text: string): string => collapseToLine(text).slice(0, INSIGHT_FIELD_CHARS);
  const display = insights.map((i) => ({
    ...i,
    title: clip(i.title),
    location: clip(i.location),
    description: clip(i.description),
  }));
  const body = [
    `Agents noted ${total === 1 ? 'this improvement' : 'these improvements'} outside the task's scope and did not make ${total === 1 ? 'it' : 'them'}. ${nextStep}`,
    '',
    ...display.map(
      (i) =>
        `- ${asPlainText(i.title)}${i.location ? ` (${code(i.location)})` : ''}${i.description && i.description !== i.location ? ` — ${asPlainText(i.description)}` : ''} (from ${i.sourceStep})`,
    ),
    ...(omitted > 0 ? ['', `${omitted} more not shown.`] : []),
  ].join('\n');
  return {
    label: 'Out-of-scope findings — not acted on',
    status: 'info',
    statusLabel: `${total} FOUND`,
    detail: `${total} ${total === 1 ? 'improvement' : 'improvements'} noted outside the task's scope`,
    body,
    defaultOpen: false,
  };
}
