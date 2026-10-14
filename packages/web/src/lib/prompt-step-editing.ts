import {
  PROMPT_STEP_TIMEOUT_MAX_MS,
  PROMPT_STEP_TIMEOUT_MIN_MS,
  derivePromptStepComposable,
  isCustomStepId,
  promptStepId,
  rewriteStepTokens,
  validatePromptStep,
  type ComposableStepEntry,
  type PromptStepEntry,
} from '@haive/shared/modularity';
import type { CatalogEntries, PromptStepIssue } from './composition-messages';

export type PromptSteps = Record<string, PromptStepEntry>;

export const DEFAULT_PROMPT_STEP_TIMEOUT_MS = 5 * 60_000;
export const PROMPT_STEP_TIMEOUT_MIN_MINUTES = PROMPT_STEP_TIMEOUT_MIN_MS / 60_000;
export const PROMPT_STEP_TIMEOUT_MAX_MINUTES = PROMPT_STEP_TIMEOUT_MAX_MS / 60_000;

export function newPromptStep(takenSlugs: Iterable<string>): PromptStepEntry {
  const taken = new Set(takenSlugs);
  let n = 1;
  while (taken.has(n === 1 ? 'prompt-step' : `prompt-step-${n}`)) n += 1;
  return {
    slug: n === 1 ? 'prompt-step' : `prompt-step-${n}`,
    title: n === 1 ? 'Prompt step' : `Prompt step ${n}`,
    template: '',
    capabilities: [],
    tools: [],
    timeoutMs: DEFAULT_PROMPT_STEP_TIMEOUT_MS,
  };
}

/** The slugs a new step must not take: the saved entries and every custom id already in the list. */
export function takenPromptSlugs(
  promptSteps: PromptSteps,
  stepIds: readonly string[],
  typeSlug: string,
): string[] {
  const prefix = `custom.${typeSlug}.`;
  return [
    ...Object.keys(promptSteps),
    ...stepIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)),
  ];
}

export function promptStepSlugOf(stepId: string, typeSlug: string): string | null {
  const prefix = `custom.${typeSlug}.`;
  return isCustomStepId(stepId) && stepId.startsWith(prefix) ? stepId.slice(prefix.length) : null;
}

export function withPromptStepEntries(
  base: CatalogEntries,
  typeSlug: string,
  requiresRepository: boolean,
  promptSteps: PromptSteps,
): Map<string, ComposableStepEntry> {
  const merged = new Map(base);
  for (const entry of Object.values(promptSteps)) {
    merged.set(
      promptStepId(typeSlug, entry.slug),
      derivePromptStepComposable(entry, typeSlug, requiresRepository),
    );
  }
  return merged;
}

/** The server's check of a prompt step, run on the list as it stands plus the two things the api's schema also demands. */
export function promptStepIssues(input: {
  typeSlug: string;
  stepIds: readonly string[];
  requiresRepository: boolean;
  promptSteps: PromptSteps;
  catalog: CatalogEntries;
}): PromptStepIssue[] {
  const { typeSlug, stepIds, promptSteps } = input;
  const byId = new Map(
    Object.values(promptSteps).map((entry) => [promptStepId(typeSlug, entry.slug), entry]),
  );
  const quotable = new Set([
    ...[...input.catalog.values()]
      .filter((e) => e.agentAuthoredOutput === true)
      .map((e) => e.stepId),
    ...byId.keys(),
  ]);
  const issues: PromptStepIssue[] = [];
  stepIds.forEach((stepId, index) => {
    const entry = byId.get(stepId);
    if (!entry) return;
    if (entry.title.trim() === '') issues.push({ kind: 'title-empty', stepId, index });
    if (entry.template.trim() === '') issues.push({ kind: 'template-empty', stepId, index });
    for (const { kind, raw, start } of validatePromptStep(entry, {
      typeSlug,
      requiresRepository: input.requiresRepository,
      stepIdsBefore: stepIds.slice(0, index),
      quotableStepIds: quotable,
    })) {
      issues.push({ kind, stepId, index, raw, start });
    }
  });
  return issues;
}

export function renamePromptStepIds(stepIds: string[], fromSlug: string, toSlug: string): string[] {
  if (fromSlug === toSlug) return stepIds;
  const prefix = `custom.${fromSlug}.`;
  if (!stepIds.some((id) => id.startsWith(prefix))) return stepIds;
  return stepIds.map((id) =>
    id.startsWith(prefix) ? `custom.${toSlug}.${id.slice(prefix.length)}` : id,
  );
}

export function renamePromptStepTokens(
  promptSteps: PromptSteps,
  fromSlug: string,
  toSlug: string,
): PromptSteps {
  if (fromSlug === toSlug) return promptSteps;
  const prefix = `custom.${fromSlug}.`;
  const rename = (id: string) =>
    id.startsWith(prefix) ? `custom.${toSlug}.${id.slice(prefix.length)}` : null;
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(promptSteps).map(([slug, entry]) => {
      const template = rewriteStepTokens(entry.template, rename);
      if (template === entry.template) return [slug, entry];
      changed = true;
      return [slug, { ...entry, template }];
    }),
  );
  return changed ? next : promptSteps;
}

export function listedPromptSteps(
  promptSteps: PromptSteps,
  stepIds: readonly string[],
  typeSlug: string,
): PromptSteps {
  const listed = new Set(stepIds);
  return Object.fromEntries(
    Object.entries(promptSteps).filter(([slug]) => listed.has(promptStepId(typeSlug, slug))),
  );
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

function sameEntry(a: PromptStepEntry, b: PromptStepEntry): boolean {
  return (
    a.slug === b.slug &&
    a.title === b.title &&
    a.template === b.template &&
    a.timeoutMs === b.timeoutMs &&
    (a.description ?? '') === (b.description ?? '') &&
    sameList(a.capabilities, b.capabilities) &&
    JSON.stringify(a.paramFormSchema ?? null) === JSON.stringify(b.paramFormSchema ?? null)
  );
}

export function samePromptSteps(a: PromptSteps, b: PromptSteps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] !== undefined && b[k] !== undefined && sameEntry(a[k], b[k]));
}
