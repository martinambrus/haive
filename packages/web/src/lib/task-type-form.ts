import type { FormSchema } from '@haive/shared';
import {
  CUSTOM_TASK_TYPE_SLUG_PATTERN,
  RESERVED_TASK_TYPE_SLUGS,
  type CustomTaskTypeCreate,
  type TaskTypeUpdate,
} from '@haive/shared/modularity';
import type { FormValues } from '@/components/form-validation';

/** The page /admin/task-types/new takes this path, so a type with this slug could never be opened. */
export const RESERVED_SLUG = RESERVED_TASK_TYPE_SLUGS[0]!;

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
  if (slug === RESERVED_SLUG) return `"${RESERVED_SLUG}" is reserved for the new-type page.`;
  return null;
}

export function buildCreateBody(
  values: FormValues,
  composition: { stepIds: string[]; loopLimits: Record<string, number> },
): CustomTaskTypeCreate {
  const flat = flatValues(values, FLAT_FIELDS);
  const description = text(values.description).trim();
  return {
    slug: text(values.slug).trim(),
    displayName: flat.displayName ?? '',
    ...(description === '' ? {} : { description }),
    stepIds: composition.stepIds,
    ...(Object.keys(composition.loopLimits).length > 0
      ? { stepLoopLimitDefaults: composition.loopLimits }
      : {}),
    requiresRepository: flat.requiresRepository ?? true,
    selectable: flat.selectable,
    enabled: flat.enabled,
    sortOrder: flat.sortOrder,
  };
}

/** Only fields the api lets this row change are sent, since it refuses the whole request over any other. */
export function buildUpdateBody(
  values: FormValues,
  editableFields: readonly string[],
  composition: {
    stepIds: string[];
    loopLimits: Record<string, number>;
    preAnswerDefaults: Record<string, Record<string, unknown>>;
  } | null,
  saved: { requiresRepository: boolean },
): TaskTypeUpdate {
  const body = flatValues(values, editableFields);
  // The api re-checks the composition whenever requiresRepository is present.
  if (body.requiresRepository === saved.requiresRepository) delete body.requiresRepository;
  if (composition && editableFields.includes('stepIds')) {
    const listed = new Set(composition.stepIds);
    body.stepIds = composition.stepIds;
    body.stepLoopLimitDefaults = composition.loopLimits;
    body.preAnswerDefaults = Object.fromEntries(
      Object.entries(composition.preAnswerDefaults).filter(([id]) => listed.has(id)),
    );
  }
  return body;
}
