import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StatusSummaryItem } from '@haive/shared';
import { collapseToLine } from '../_untrusted-repo.js';
import { loadInsightOutputs, parseInsights, type Insight } from './08e-insights-triage.js';
import { code } from './_plan-ops.js';
import { asPlainText } from './_similar-sites.js';

export const INSIGHTS_AT_GATE = 30;
const INSIGHT_FIELD_CHARS = 200;

const insightKey = (i: { title: string; location: string }): string =>
  `${i.title}::${i.location}`.toLowerCase();

/** The optional improvements agents noted in this task that nobody picked at 08e, one line of
 *  bounded text each. 08e's picks are subtracted across every round by title and location, since
 *  its `i-N` ids are positions. Only the result is capped, and what the cap cuts is counted. */
export async function loadUnactedInsights(
  db: Database,
  taskId: string,
): Promise<{ insights: Insight[]; omitted: number }> {
  const all = parseInsights(await loadInsightOutputs(db, taskId), Number.POSITIVE_INFINITY);
  const triage = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '08e-insights-triage')),
    );
  const picked = new Set<string>();
  for (const row of triage) {
    const selected = (row.output as { selected?: unknown } | null)?.selected;
    if (!Array.isArray(selected)) continue;
    for (const s of selected as Partial<Insight>[]) {
      if (typeof s?.title !== 'string') continue;
      picked.add(insightKey({ title: s.title, location: s.location ?? '' }));
    }
  }
  const clip = (text: string): string => collapseToLine(text).slice(0, INSIGHT_FIELD_CHARS);
  const left = all
    .filter((i) => !picked.has(insightKey(i)))
    .map((i) => ({
      ...i,
      title: clip(i.title),
      location: clip(i.location),
      description: clip(i.description),
    }));
  return {
    insights: left.slice(0, INSIGHTS_AT_GATE),
    omitted: Math.max(0, left.length - INSIGHTS_AT_GATE),
  };
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
  const body = [
    `Agents noted ${total === 1 ? 'this improvement' : 'these improvements'} outside the task's scope and did not make ${total === 1 ? 'it' : 'them'}. ${nextStep}`,
    '',
    ...insights.map(
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
