import type {
  TaskCallOutcomeCounts,
  TaskCustomToolCall,
  TaskIntegrationCall,
  TaskToolUsage,
} from './api-client';

type ToolUsageStep = TaskToolUsage['steps'][number];

const NONE = '—';
// The api stores no name for a call to a tool the step never declared.
const UNDECLARED_TOOL = '(undeclared)';

function outcomesOf(counts: TaskCallOutcomeCounts): string {
  const parts: Array<[number, string]> = [
    [counts.ok, 'ok'],
    [counts.refused, 'refused'],
    [counts.error, 'failed'],
    [counts.running, 'running'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ');
}

export function customToolsCell(entries: TaskCustomToolCall[]): string {
  if (entries.length === 0) return NONE;
  return entries.map((e) => `${e.tool || UNDECLARED_TOOL} ${outcomesOf(e)}`).join(', ');
}

export function integrationsCell(entries: TaskIntegrationCall[]): string {
  if (entries.length === 0) return NONE;
  return entries.map((e) => `${e.providerId}/${e.tool} (${e.access}) ${outcomesOf(e)}`).join(', ');
}

export function toolUsageRows(steps: ToolUsageStep[]): ToolUsageStep[] {
  return steps.filter(
    (s) => s.usage !== null || s.customTools.length > 0 || s.integrations.length > 0,
  );
}

export function hasNothingToShow(data: Pick<TaskToolUsage, 'coverage' | 'callTotals'>): boolean {
  return (
    data.coverage.total === 0 &&
    data.callTotals.customTools.length === 0 &&
    data.callTotals.integrations.length === 0
  );
}
