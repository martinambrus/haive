import {
  INVALID_TOOLS_SHOWN,
  describeInvalidTools,
  validateCustomTools,
  type CustomTool,
  type CustomToolProblem,
} from '@haive/shared/modularity';

export const CUSTOM_TOOL_INVALID_REASON = 'custom-tool-invalid';

export const invalidToolsFailure = (found: string): string =>
  `${CUSTOM_TOOL_INVALID_REASON}: this step's tools no longer pass their checks: ${found} The task pinned them when it was created; fix them in the task type and start a new task.`;

/** The problems of a step's tools, each led by its tool as inline code: at most 8, then how many more. */
function describeToolProblems(problems: readonly CustomToolProblem[]): string {
  const shown = problems
    .slice(0, INVALID_TOOLS_SHOWN)
    .map((problem) => `${describeInvalidTools([problem.tool])}: ${problem.message}`);
  const more = problems.length - shown.length;
  return `${shown.join(' ')}${more > 0 ? ` And ${more} more.` : ''}`;
}

/** The failure for pinned tools that fail the checks a save runs today, or null when they all pass. */
export function pinnedToolsFailure(tools: readonly CustomTool[]): string | null {
  // The type's requiresRepository is not known here; it only decides a rag-query tool's scope.
  const problems = validateCustomTools(tools, { requiresRepository: true });
  return problems.length > 0 ? invalidToolsFailure(describeToolProblems(problems)) : null;
}
