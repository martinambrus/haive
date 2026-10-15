import type { FormSchema } from '@haive/shared';
import {
  CUSTOM_TASK_TYPE_SLUG_PATTERN,
  RESERVED_TASK_TYPE_SLUGS,
  type CustomTaskTypeCreate,
  type TaskTypeUpdate,
} from '@haive/shared/modularity';
import type { FormValues } from '@/components/form-validation';
import { pruneLoopLimits } from './composition-order';
import {
  listedPromptSteps,
  samePromptSteps,
  type PromptSteps,
  type StoredPromptSteps,
} from './prompt-step-editing';

const FLAT_FIELDS = [
  'displayName',
  'description',
  'requiresRepository',
  'enabled',
  'selectable',
  'sortOrder',
] as const;

export function taskTypeFormSchema(
  editableFields: readonly string[],
  mode: 'create' | 'edit',
): FormSchema {
  const editable = (id: (typeof FLAT_FIELDS)[number]) => editableFields.includes(id);
  const fields: FormSchema['fields'] = [];
  if (mode === 'create') {
    fields.push({
      id: 'slug',
      type: 'text',
      label: 'Slug',
      required: true,
      placeholder: 'my-task-type',
      description: 'Lowercase letters, digits and hyphens. It cannot be changed afterwards.',
    });
  }
  if (editable('displayName')) {
    fields.push({ id: 'displayName', type: 'text', label: 'Name', required: true });
  }
  if (editable('description')) {
    fields.push({ id: 'description', type: 'textarea', label: 'Description', rows: 3 });
  }
  if (editable('requiresRepository')) {
    fields.push({
      id: 'requiresRepository',
      type: 'checkbox',
      label: 'Requires a repository',
      description:
        'Off lets the task start without one; steps that need a repository are then flagged.',
      default: true,
    });
  }
  if (editable('enabled')) {
    fields.push({ id: 'enabled', type: 'checkbox', label: 'Enabled', default: true });
  }
  if (editable('selectable')) {
    fields.push({
      id: 'selectable',
      type: 'checkbox',
      label: 'Selectable on the New Task page',
      default: true,
    });
  }
  if (editable('sortOrder')) {
    fields.push({
      id: 'sortOrder',
      type: 'number',
      label: 'Sort order',
      step: 1,
      default: 0,
      description: 'Lower numbers come first.',
    });
  }
  return {
    title: 'Task type',
    fields,
    submitLabel: mode === 'create' ? 'Create task type' : 'Save changes',
  };
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');
const sortOrderOf = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : 0);

function flatValues(values: FormValues, editableFields: readonly string[]): TaskTypeUpdate {
  const out: TaskTypeUpdate = {};
  if (editableFields.includes('displayName')) out.displayName = text(values.displayName).trim();
  if (editableFields.includes('description')) out.description = text(values.description);
  if (editableFields.includes('requiresRepository')) {
    out.requiresRepository = values.requiresRepository === true;
  }
  if (editableFields.includes('enabled')) out.enabled = values.enabled === true;
  if (editableFields.includes('selectable')) out.selectable = values.selectable === true;
  if (editableFields.includes('sortOrder')) out.sortOrder = sortOrderOf(values.sortOrder);
  return out;
}

export function slugProblem(slug: string): string | null {
  if (!CUSTOM_TASK_TYPE_SLUG_PATTERN.test(slug)) {
    return 'The slug may use lowercase letters, digits and hyphens, starting with a letter or digit.';
  }
  if (RESERVED_TASK_TYPE_SLUGS.includes(slug)) {
    return `"${slug}" is reserved: a task type with it could not be opened.`;
  }
  return null;
}

export function buildCreateBody(
  values: FormValues,
  composition: {
    stepIds: string[];
    loopLimits: Record<string, number>;
    promptSteps?: PromptSteps;
  },
): CustomTaskTypeCreate {
  const flat = flatValues(values, FLAT_FIELDS);
  const description = text(values.description).trim();
  const slug = text(values.slug).trim();
  const promptSteps = listedPromptSteps(composition.promptSteps ?? {}, composition.stepIds, slug);
  return {
    slug,
    displayName: flat.displayName ?? '',
    ...(description === '' ? {} : { description }),
    stepIds: composition.stepIds,
    ...(Object.keys(composition.loopLimits).length > 0
      ? { stepLoopLimitDefaults: composition.loopLimits }
      : {}),
    ...(Object.keys(promptSteps).length > 0 ? { promptSteps } : {}),
    requiresRepository: flat.requiresRepository ?? true,
    selectable: flat.selectable,
    enabled: flat.enabled,
    sortOrder: flat.sortOrder,
  };
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function sameLimits(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => a[k] === b[k]);
}

export function compositionChanged(
  current: {
    stepIds: readonly string[];
    loopLimits: Record<string, number>;
    promptSteps?: PromptSteps;
  },
  saved: {
    stepIds: readonly string[] | null;
    stepLoopLimitDefaults: Record<string, number>;
    promptSteps?: StoredPromptSteps;
  },
): boolean {
  return (
    !sameIds(current.stepIds, saved.stepIds ?? []) ||
    !sameLimits(current.loopLimits, saved.stepLoopLimitDefaults) ||
    !samePromptSteps(current.promptSteps ?? {}, saved.promptSteps ?? {})
  );
}

/** Only changed fields the api lets this row change are sent, since it refuses the whole request over any other. */
export function buildUpdateBody(
  values: FormValues,
  editableFields: readonly string[],
  composition: {
    stepIds: string[];
    loopLimits: Record<string, number>;
    promptSteps?: PromptSteps;
    typeSlug?: string;
    saved: {
      stepIds: readonly string[] | null;
      stepLoopLimitDefaults: Record<string, number>;
      promptSteps?: StoredPromptSteps;
    };
  } | null,
  saved: Partial<Record<(typeof FLAT_FIELDS)[number], unknown>>,
): TaskTypeUpdate {
  const body = flatValues(values, editableFields);
  // Unchanged fields stay out: a stale page must not undo another edit, and the api
  // re-checks the composition whenever requiresRepository is present.
  for (const field of FLAT_FIELDS) {
    if (field in body && body[field] === saved[field]) delete body[field];
  }
  if (composition && editableFields.includes('stepIds')) {
    const { saved: was } = composition;
    if (!sameIds(composition.stepIds, was.stepIds ?? [])) body.stepIds = composition.stepIds;
    // The api drops what a removed step left behind, so a removal alone sends neither map.
    const keptLimits = pruneLoopLimits(was.stepLoopLimitDefaults, composition.stepIds);
    if (!sameLimits(composition.loopLimits, keptLimits)) {
      body.stepLoopLimitDefaults = composition.loopLimits;
    }
    if (editableFields.includes('promptSteps')) {
      const listedNow = listedPromptSteps(
        composition.promptSteps ?? {},
        composition.stepIds,
        composition.typeSlug ?? '',
      );
      if (!samePromptSteps(listedNow, was.promptSteps ?? {})) body.promptSteps = listedNow;
    }
  }
  return body;
}
