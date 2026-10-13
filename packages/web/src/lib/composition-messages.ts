import {
  REPOSITORY_TOKEN,
  validateComposition,
  validateTaskTypeDefaults,
  type ComposableStepEntry,
  type CompositionIssue,
  type TaskTypeAvailability,
  type TaskTypeDefaultsIssue,
} from '@haive/shared/modularity';
import type { TaskTypeCatalog } from './api-client';

export type CatalogEntries = ReadonlyMap<string, ComposableStepEntry>;

export interface StepRef {
  stepId: string;
  label: string;
}

export interface IssueView {
  message: string;
  providedBy: StepRef[];
}

export interface IssueContext {
  stepIds: readonly string[];
  catalog: CatalogEntries;
  requiresRepository: boolean;
}

export function catalogEntries(
  catalog: Pick<TaskTypeCatalog, 'steps'>,
): Map<string, ComposableStepEntry> {
  return new Map(catalog.steps.map((s) => [s.stepId, s.entry]));
}

export function stepLabel(stepId: string, catalog: CatalogEntries): string {
  return catalog.get(stepId)?.label ?? stepId;
}

export function providersOf(
  token: string,
  catalog: CatalogEntries,
  exceptStepId?: string,
): StepRef[] {
  const out: StepRef[] = [];
  for (const [stepId, entry] of catalog) {
    if (stepId !== exceptStepId && entry.provides.includes(token)) {
      out.push({ stepId, label: entry.label });
    }
  }
  return out;
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

function joinOr(labels: string[]): string {
  return labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

export function describeIssue(issue: CompositionIssue, ctx: IssueContext): IssueView {
  const { catalog } = ctx;
  const label = (id: string) => stepLabel(id, catalog);
  switch (issue.kind) {
    case 'empty':
      return { message: 'Add at least one step.', providedBy: [] };
    case 'unknown-step':
      return {
        message: `${issue.stepId} is not in the step catalog (removed or its module is off).`,
        providedBy: [],
      };
    case 'duplicate-step': {
      const first = ctx.stepIds.indexOf(issue.stepId);
      return { message: `${label(issue.stepId)} is already step ${first + 1}.`, providedBy: [] };
    }
    case 'unmet-need':
      if (issue.needs === REPOSITORY_TOKEN && !ctx.requiresRepository) {
        return {
          message: "Requires a repository: turn on 'Requires repository' or remove this step.",
          providedBy: [],
        };
      }
      return {
        message: `Needs ${issue.needs} first: ${sentence(issue.reason)}`,
        providedBy: providersOf(issue.needs, catalog, issue.stepId),
      };
    case 'too-late': {
      const earlier = ctx.stepIds
        .slice(0, issue.index)
        .find((id) => catalog.get(id)?.provides.includes(issue.token));
      const tail = earlier ? `; currently after ${label(earlier)}.` : '.';
      return {
        message: `Must run before any step that provides ${issue.token}${tail}`,
        providedBy: [],
      };
    }
    case 'unfulfilled': {
      const providers = providersOf(issue.token, catalog, issue.stepId);
      const what =
        providers.length > 0
          ? joinOr(providers.map((p) => p.label))
          : `a step that provides ${issue.token}`;
      return {
        message: `Starts something that ${issue.token} must finish later: add ${what} after it.`,
        providedBy: providers,
      };
    }
    case 'missing-loop-target':
      return {
        message: `Loops back to ${label(issue.target)}, which must come earlier.`,
        providedBy: [{ stepId: issue.target, label: label(issue.target) }],
      };
    case 'loop-after-closing':
      return {
        message: `Its fix loop would return past ${label(issue.closingStepId)}, which closes the run; move it before that step.`,
        providedBy: [],
      };
  }
}

export function describeDefaultsIssue(
  issue: TaskTypeDefaultsIssue,
  catalog: CatalogEntries,
): string {
  if (issue.kind === 'loop-limit-not-editable') {
    return `${stepLabel(issue.stepId, catalog)} has no loop limit to set.`;
  }
  const what = issue.field === 'stepLoopLimitDefaults' ? 'A loop limit' : 'A preset answer';
  return `${what} is set for ${issue.stepId}, which is not in the list.`;
}

export function issuesByRow(issues: readonly CompositionIssue[]): Map<number, CompositionIssue[]> {
  const rows = new Map<number, CompositionIssue[]>();
  for (const issue of issues) {
    if (!('index' in issue)) continue;
    rows.set(issue.index, [...(rows.get(issue.index) ?? []), issue]);
  }
  return rows;
}

export function compositionProblems(input: {
  stepIds: readonly string[];
  loopLimits: Record<string, number>;
  catalog: CatalogEntries;
  requiresRepository: boolean;
}): { composition: CompositionIssue[]; defaults: TaskTypeDefaultsIssue[] } {
  return {
    composition: validateComposition(input.stepIds, input.catalog, {
      requiresRepository: input.requiresRepository,
    }),
    defaults: validateTaskTypeDefaults(
      { stepIds: input.stepIds, stepLoopLimitDefaults: input.loopLimits },
      input.catalog,
    ),
  };
}

const COMPOSITION_KINDS: ReadonlySet<string> = new Set<CompositionIssue['kind']>([
  'empty',
  'unknown-step',
  'unmet-need',
  'too-late',
  'unfulfilled',
  'missing-loop-target',
  'duplicate-step',
  'loop-after-closing',
]);
const DEFAULTS_KINDS: ReadonlySet<string> = new Set<TaskTypeDefaultsIssue['kind']>([
  'default-key-not-in-steps',
  'loop-limit-not-editable',
]);

/** Sorts an error body's `issues` by shape: composition and defaults issues carry `kind`, validation issues `path` and `message`. */
export function splitServerIssues(issues: unknown): {
  composition: CompositionIssue[];
  defaults: TaskTypeDefaultsIssue[];
  fields: { path: string; message: string }[];
} {
  const out = {
    composition: [] as CompositionIssue[],
    defaults: [] as TaskTypeDefaultsIssue[],
    fields: [] as { path: string; message: string }[],
  };
  if (!Array.isArray(issues)) return out;
  for (const item of issues as Record<string, unknown>[]) {
    if (typeof item?.kind === 'string') {
      if (COMPOSITION_KINDS.has(item.kind))
        out.composition.push(item as unknown as CompositionIssue);
      else if (DEFAULTS_KINDS.has(item.kind))
        out.defaults.push(item as unknown as TaskTypeDefaultsIssue);
    } else if (typeof item?.message === 'string') {
      out.fields.push({
        path: typeof item.path === 'string' ? item.path : '',
        message: item.message,
      });
    }
  }
  return out;
}

export function describeAvailability(availability: TaskTypeAvailability): string {
  if (availability.available) return 'Available';
  switch (availability.reason) {
    case 'disabled':
      return 'Unavailable: disabled';
    case 'not-selectable':
      return 'Unavailable: not selectable on the New Task page';
    case 'custom-types-off':
      return 'Unavailable: custom task types are switched off';
    case 'module-types-off':
      return 'Unavailable: module task types are switched off';
    case 'missing-step':
      return `Unavailable: missing steps ${(availability.stepIds ?? []).join(', ')}`;
    case 'invalid-composition': {
      const n = availability.issues?.length ?? 0;
      return `Unavailable: the step list has ${n} problem${n === 1 ? '' : 's'}`;
    }
  }
}
