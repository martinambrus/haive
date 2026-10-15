import {
  parseStepId,
  PROMPT_STEP_DRAFTABLE_KEYS,
  rewriteStepTokens,
  type PromptStepEntry,
} from '@haive/shared/modularity';
import type { FormValues } from '@/components/form-validation';
import { DEFAULT_PROMPT_STEP_TIMEOUT_MS, type PromptSteps } from './prompt-step-editing';

export interface DraftEditorState {
  stepIds: string[];
  loopLimits: Record<string, number>;
  promptSteps: PromptSteps;
  values: FormValues;
}

type DraftableKey = (typeof PROMPT_STEP_DRAFTABLE_KEYS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

// A key added to PROMPT_STEP_DRAFTABLE_KEYS does not compile here until it has a guard.
const FITS: Record<DraftableKey, (value: unknown) => boolean> = {
  slug: isText,
  title: isText,
  template: isText,
  capabilities: isTexts,
  timeoutMs: (value) => typeof value === 'number',
};

function draftedStep(
  slug: string,
  raw: Record<string, unknown>,
  saved: PromptStepEntry | undefined,
): PromptStepEntry {
  const base: PromptStepEntry = saved ?? {
    slug,
    title: '',
    template: '',
    capabilities: [],
    tools: [],
    timeoutMs: DEFAULT_PROMPT_STEP_TIMEOUT_MS,
  };
  const picked: Record<string, unknown> = {};
  for (const key of PROMPT_STEP_DRAFTABLE_KEYS) {
    if (FITS[key](raw[key])) picked[key] = raw[key];
  }
  return { ...base, ...picked } as PromptStepEntry;
}

/** A saved type keeps its slug, so the steps of a draft that renamed it are named under the saved one. */
const underSlug =
  (typeSlug: string) =>
  (id: string): string | null => {
    const parsed = parseStepId(id);
    return parsed?.kind === 'custom' ? `custom.${typeSlug}.${parsed.stepSlug}` : null;
  };

/** The draft is the whole task type: an optional part it leaves out is cleared, a required part it gets wrong stays as the editor had it. */
export function loadDraftIntoEditor(
  editor: DraftEditorState,
  draft: Record<string, unknown>,
  { creating, slug: typeSlug }: { creating: boolean; slug: string },
): DraftEditorState {
  const rename = creating ? null : underSlug(typeSlug);
  const values: FormValues = { ...editor.values };
  if (creating && isText(draft.slug)) values.slug = draft.slug;
  if (isText(draft.displayName)) values.displayName = draft.displayName;
  values.description = isText(draft.description) ? draft.description : '';
  if (typeof draft.requiresRepository === 'boolean') {
    values.requiresRepository = draft.requiresRepository;
  }
  const limits = isRecord(draft.stepLoopLimitDefaults) ? draft.stepLoopLimitDefaults : {};
  const steps: [string, PromptStepEntry][] = [];
  for (const [slug, raw] of Object.entries(isRecord(draft.promptSteps) ? draft.promptSteps : {})) {
    if (!isRecord(raw)) continue;
    const saved = Object.hasOwn(editor.promptSteps, slug) ? editor.promptSteps[slug] : undefined;
    const step = draftedStep(slug, raw, saved);
    steps.push([
      slug,
      rename ? { ...step, template: rewriteStepTokens(step.template, rename) } : step,
    ]);
  }
  return {
    stepIds: isTexts(draft.stepIds)
      ? draft.stepIds.map((id) => rename?.(id) ?? id)
      : editor.stepIds,
    loopLimits: Object.fromEntries(
      Object.entries(limits).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    ),
    promptSteps: Object.fromEntries(steps),
    values,
  };
}

const text = (value: unknown): string => (isText(value) ? value : '');

export function editorStateForAgent(editor: DraftEditorState): Record<string, unknown> {
  return {
    slug: text(editor.values.slug),
    displayName: text(editor.values.displayName),
    description: text(editor.values.description),
    requiresRepository: editor.values.requiresRepository === true,
    stepIds: editor.stepIds,
    stepLoopLimitDefaults: editor.loopLimits,
    promptSteps: Object.fromEntries(
      Object.entries(editor.promptSteps).map(([slug, entry]) => [
        slug,
        Object.fromEntries(PROMPT_STEP_DRAFTABLE_KEYS.map((key) => [key, entry[key]])),
      ]),
    ),
  };
}
