import { isFieldVisible, type FormField, type FormSchema } from '../schemas/form.js';

export interface FormValidationSuccess {
  success: true;
  data: Record<string, unknown>;
}

export interface FormValidationFailure {
  success: false;
  issues: string[];
}

export function validateFormValues(
  schema: FormSchema,
  values: unknown,
): FormValidationSuccess | FormValidationFailure {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    return { success: false, issues: ['form values must be an object'] };
  }
  const input = values as Record<string, unknown>;
  const issues: string[] = [];
  const data: Record<string, unknown> = {};
  for (const field of schema.fields) {
    processField(field, input, data, issues);
  }
  if (issues.length > 0) return { success: false, issues };
  return { success: true, data };
}

function processField(
  field: FormField,
  input: Record<string, unknown>,
  data: Record<string, unknown>,
  issues: string[],
): void {
  if (field.type === 'accordion') {
    for (const item of field.items) {
      for (const leaf of item.fields) {
        processField(leaf, input, data, issues);
      }
    }
    return;
  }
  // A field the renderer hides is one the user was never offered, so enforcing its
  // `required` flag rejects a submission they had no way to complete. Treated as
  // optional rather than dropped: a hidden field still contributes its default, which
  // is what hidden-and-optional fields already did.
  const visible = isFieldVisible(field, input);
  const raw = input[field.id];
  const coerced = coerceField(field, raw, issues, visible);
  if (coerced !== undefined) data[field.id] = coerced;
}

function coerceField(field: FormField, raw: unknown, issues: string[], visible = true): unknown {
  const present = raw !== undefined && raw !== null && raw !== '';
  if (!present) {
    if (field.required && visible) {
      issues.push(`${field.id}: required`);
      return undefined;
    }
    return defaultFor(field);
  }
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'select-with-text':
    case 'radio-with-textarea':
      if (typeof raw !== 'string') {
        issues.push(`${field.id}: expected string`);
        return undefined;
      }
      return raw;
    case 'directory-picker':
      if (typeof raw !== 'string') {
        issues.push(`${field.id}: expected string`);
        return undefined;
      }
      return raw;
    case 'select':
    case 'radio': {
      if (typeof raw !== 'string') {
        issues.push(`${field.id}: expected string`);
        return undefined;
      }
      if (!field.options.some((o) => o.value === raw)) {
        issues.push(`${field.id}: invalid option`);
        return undefined;
      }
      return raw;
    }
    case 'multi-select': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        issues.push(`${field.id}: expected string[]`);
        return undefined;
      }
      const arr = raw as string[];
      const allowed = new Set(field.options.map((o) => o.value));
      for (const v of arr) {
        if (!allowed.has(v)) {
          issues.push(`${field.id}: invalid option ${v}`);
          return undefined;
        }
      }
      return arr;
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') {
        issues.push(`${field.id}: expected boolean`);
        return undefined;
      }
      return raw;
    case 'number':
      if (typeof raw !== 'number' || Number.isNaN(raw)) {
        issues.push(`${field.id}: expected number`);
        return undefined;
      }
      if (field.min !== undefined && raw < field.min) {
        issues.push(`${field.id}: below min ${field.min}`);
        return undefined;
      }
      if (field.max !== undefined && raw > field.max) {
        issues.push(`${field.id}: above max ${field.max}`);
        return undefined;
      }
      return raw;
    case 'file-upload':
      return raw;
    case 'directory-tree': {
      // Selected directory paths. Validated as a string[]; paths are checked
      // against the tree downstream (unknown paths are simply not kept in scope),
      // so no per-option allow-list here. A MISSING case previously fell through to
      // `default: return undefined`, which silently STRIPPED the whole selection
      // (the mining/RAG scope pickers submitted their paths but apply saw {}).
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        issues.push(`${field.id}: expected string[]`);
        return undefined;
      }
      return raw as string[];
    }
    case 'bundle-composer': {
      // The bundles chosen for this repository, as the composer reports them: entries
      // are `{ id, name, sourceType, status, itemCount }`, and a bare id string is
      // accepted because `extractBundleIdsFromValues` (06_3) reads both. Only the id
      // is checked here — the row itself is re-read from the database at apply, which
      // is what decides whether the bundle exists and whether it synced.
      //
      // A MISSING case fell through to `default: return undefined`, which STRIPPED the
      // whole selection while still reporting `success: true` — MEASURED end to end: the
      // browser posted `{"bundles":[{...}]}`, the API stored it and logged fieldCount 1,
      // then the runner re-validated, wrote `{}` back over the row, and apply recorded
      // `bundleIds: []`, so the step showed no bundle and could raise no
      // syncing/failed warning for one. Exactly the `directory-tree` failure above.
      if (!Array.isArray(raw)) {
        issues.push(`${field.id}: expected an array of bundles`);
        return undefined;
      }
      for (const entry of raw) {
        const id =
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object' && 'id' in entry
              ? (entry as { id: unknown }).id
              : undefined;
        if (typeof id !== 'string' || id.length === 0) {
          issues.push(`${field.id}: every entry needs a non-empty id`);
          return undefined;
        }
      }
      return raw;
    }
    // Display-only fields carry no value, so dropping them is correct. Listed
    // explicitly rather than left to `default` so the exhaustiveness check below
    // still holds.
    case 'note':
    case 'global-kb-status':
      return undefined;
    // `accordion` never reaches here — processField recurses into its leaves and
    // returns — but it is part of FormField, so it has to be named for the check.
    case 'accordion':
      return undefined;
    default: {
      // Every field type is handled above, and a NEW one fails the build here rather
      // than silently losing whatever the user submitted for it. That is not
      // hypothetical: this switch has dropped a real selection twice, `directory-tree`
      // and `bundle-composer`, and both times it reported success while doing it.
      const unhandled: never = field;
      void unhandled;
      return undefined;
    }
  }
}

function defaultFor(field: FormField): unknown {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'select':
    case 'radio':
    case 'directory-picker':
    case 'select-with-text':
    case 'radio-with-textarea':
      return 'default' in field ? (field.default ?? null) : null;
    case 'multi-select':
    case 'directory-tree':
      return field.defaults ?? [];
    case 'checkbox':
      return field.default ?? false;
    case 'number':
      return field.default ?? null;
    case 'file-upload':
      return null;
    case 'bundle-composer':
      // A list field: "no bundles" is an empty list, not a null.
      return [];
    default:
      return null;
  }
}

/** Builds a form-values candidate from each field's declared default, for steps
 *  that opt into unattended auto-submit (StepMetadata.autoSubmitDefaults). The
 *  runner feeds the result to validateFormValues() so the same coercion/required
 *  rules apply. Recurses accordion groups. Only fields with a concrete default
 *  contribute an entry; a field without one is omitted, so a required field with
 *  no default makes validation fail and the runner falls back to waiting_form
 *  rather than guessing a value. */
export function extractFormDefaults(schema: FormSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) collectFieldDefault(field, out);
  return out;
}

function collectFieldDefault(field: FormField, out: Record<string, unknown>): void {
  if (field.type === 'accordion') {
    for (const item of field.items) {
      for (const leaf of item.fields) collectFieldDefault(leaf, out);
    }
    return;
  }
  const value = defaultFor(field);
  if (value !== undefined && value !== null) out[field.id] = value;
}
