import { validateComposition, type CompositionIssue } from './composition.js';
import { isCustomStepId, type ComposableStepEntry } from './contracts.js';
import {
  derivePromptStepComposable,
  parsePromptTemplate,
  promptStepEntrySchema,
  promptStepId,
  validatePromptStep,
  type PromptStepEntry,
  type PromptStepProblemKind,
} from './prompt-steps.js';
import {
  customTaskTypeCreateSchema,
  validateTaskTypeDefaults,
  type TaskTypeDefaultsIssue,
} from './task-types.js';

/** Stored prompt steps by slug; an entry that no longer parses is left out, so its id reads as a missing step. */
export function parsePromptSteps(raw: unknown): Record<string, PromptStepEntry> {
  const out: Record<string, PromptStepEntry> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [slug, value] of Object.entries(raw)) {
    const parsed = promptStepEntrySchema.safeParse(value);
    if (parsed.success) out[slug] = parsed.data;
  }
  return out;
}

interface CatalogSets {
  stepIds: Set<string>;
  dispatchesCli: Set<string>;
  composable: Map<string, ComposableStepEntry>;
}

/** The catalog as one type sees it: the worker's steps plus that type's own prompt steps. */
export function mergePromptStepCatalog<C extends CatalogSets>(
  catalog: C,
  def: { slug: string; source: string; requiresRepository: boolean; promptSteps: unknown },
): C {
  if (def.source !== 'admin') return catalog;
  const entries = Object.values(parsePromptSteps(def.promptSteps));
  if (entries.length === 0) return catalog;
  const merged = {
    ...catalog,
    stepIds: new Set(catalog.stepIds),
    dispatchesCli: new Set(catalog.dispatchesCli),
    composable: new Map(catalog.composable),
  };
  for (const entry of entries) {
    const composable = derivePromptStepComposable(entry, def.slug, def.requiresRepository);
    merged.stepIds.add(composable.stepId);
    merged.dispatchesCli.add(composable.stepId);
    merged.composable.set(composable.stepId, composable);
  }
  return merged;
}

export type PromptStepIssueKind =
  PromptStepProblemKind | 'prompt-step-missing' | 'prompt-step-orphan';

export interface PromptStepIssue {
  kind: PromptStepIssueKind;
  stepId: string;
  index?: number;
  message: string;
  raw?: string;
  start?: number;
}

/** Every custom id in the step list has an entry of this type, every entry is used, and each validates where it stands. */
export function checkPromptSteps(
  def: { slug: string; stepIds: readonly string[]; requiresRepository: boolean },
  promptSteps: Record<string, PromptStepEntry>,
  catalog: { composable: ReadonlyMap<string, ComposableStepEntry> },
): PromptStepIssue[] {
  const issues: PromptStepIssue[] = [];
  const byId = new Map(
    Object.values(promptSteps).map((entry) => [promptStepId(def.slug, entry.slug), entry]),
  );
  const quotableStepIds = new Set([
    ...[...catalog.composable.values()]
      .filter((entry) => entry.agentAuthoredOutput === true)
      .map((entry) => entry.stepId),
    ...byId.keys(),
  ]);
  def.stepIds.forEach((stepId, index) => {
    if (!isCustomStepId(stepId)) return;
    const entry = byId.get(stepId);
    if (!entry) {
      issues.push({
        kind: 'prompt-step-missing',
        stepId,
        index,
        message: `${stepId} has no prompt step on this task type.`,
      });
      return;
    }
    const problems = validatePromptStep(entry, {
      typeSlug: def.slug,
      requiresRepository: def.requiresRepository,
      stepIdsBefore: def.stepIds.slice(0, index),
      quotableStepIds,
    });
    for (const { kind, message, raw, start } of problems) {
      issues.push({ kind, stepId, index, message, raw, start });
    }
  });
  for (const stepId of byId.keys()) {
    if (!def.stepIds.includes(stepId)) {
      issues.push({
        kind: 'prompt-step-orphan',
        stepId,
        message: `${stepId} is not in the step list.`,
      });
    }
  }
  return issues;
}

// A positive list: a key added to promptStepEntrySchema is not draftable until it is named here.
export const PROMPT_STEP_DRAFTABLE_KEYS = [
  'slug',
  'title',
  'template',
  'capabilities',
  'timeoutMs',
] as const;

const TASK_TYPE_DRAFT_KEYS: readonly string[] = [
  'slug',
  'displayName',
  'description',
  'requiresRepository',
  'stepIds',
  'promptSteps',
  'stepLoopLimitDefaults',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function pickPromptStep(path: string, value: unknown, dropped: string[]): unknown {
  if (!isRecord(value)) return value;
  const picked: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if ((PROMPT_STEP_DRAFTABLE_KEYS as readonly string[]).includes(key)) picked[key] = field;
    else dropped.push(`${path}.${key}`);
  }
  return picked;
}

/** Only keys are judged here; a bad value passes through for validateTaskTypeDraft to report. */
export function pickTaskTypeDraft(raw: unknown): {
  draft: Record<string, unknown>;
  dropped: string[];
} {
  const draft: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (!isRecord(raw)) return { draft, dropped };
  for (const [key, value] of Object.entries(raw)) {
    if (!TASK_TYPE_DRAFT_KEYS.includes(key)) {
      dropped.push(key);
    } else if (key === 'promptSteps' && isRecord(value)) {
      // fromEntries, not assignment: a step slug of __proto__ stays an own key.
      draft[key] = Object.fromEntries(
        Object.entries(value).map(([slug, step]) => [
          slug,
          pickPromptStep(`promptSteps.${slug}`, step, dropped),
        ]),
      );
    } else {
      draft[key] = value;
    }
  }
  return { draft, dropped };
}

export interface TaskTypeDraftWarning {
  kind: 'persona-not-in-catalog';
  stepId: string;
  raw: string;
  start: number;
  message: string;
}

/** A schema failure is {path, message} as the error handler returns it; the rest are the stages' own issues. */
export type TaskTypeDraftIssue =
  { path: string; message: string } | PromptStepIssue | CompositionIssue | TaskTypeDefaultsIssue;

function personaWarnings(
  typeSlug: string,
  promptSteps: Record<string, PromptStepEntry>,
  personaIds: Iterable<string>,
): TaskTypeDraftWarning[] {
  const known = new Set(personaIds);
  const warnings: TaskTypeDraftWarning[] = [];
  for (const entry of Object.values(promptSteps)) {
    const parsed = parsePromptTemplate(entry.template);
    if (!parsed.ok) continue;
    for (const token of parsed.tokens) {
      if (token.kind === 'agent' && !known.has(token.id)) {
        warnings.push({
          kind: 'persona-not-in-catalog',
          stepId: promptStepId(typeSlug, entry.slug),
          raw: token.raw,
          start: token.start,
          message: `${token.raw} names a persona that is not in the catalog.`,
        });
      }
    }
  }
  return warnings;
}

/** The checks POST /admin/task-types runs, in its order and stopping at the first stage that finds a problem. */
export function validateTaskTypeDraft(
  draft: unknown,
  catalog: CatalogSets,
  personaIds?: Iterable<string>,
): { issues: TaskTypeDraftIssue[]; warnings: TaskTypeDraftWarning[] } {
  const parsed = customTaskTypeCreateSchema.safeParse(draft);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return { issues, warnings: [] };
  }
  const body = parsed.data;
  const promptSteps = body.promptSteps ?? {};
  const warnings =
    personaIds === undefined ? [] : personaWarnings(body.slug, promptSteps, personaIds);
  const promptIssues = checkPromptSteps(body, promptSteps, catalog);
  if (promptIssues.length > 0) return { issues: promptIssues, warnings };
  const { composable } = mergePromptStepCatalog(catalog, {
    slug: body.slug,
    source: 'admin',
    requiresRepository: body.requiresRepository,
    promptSteps,
  });
  const issues = validateComposition(body.stepIds, composable, {
    requiresRepository: body.requiresRepository,
  });
  if (issues.length > 0) return { issues, warnings };
  return { issues: validateTaskTypeDefaults(body, composable), warnings };
}
