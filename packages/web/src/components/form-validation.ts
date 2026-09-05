import type { FormField, FormSchema } from '@haive/shared';
import { isFieldVisible } from './form-visibility';

export type FormValues = Record<string, unknown>;

export function validateRequired(schema: FormSchema, values: FormValues): string | null {
  return checkFields(schema.fields, values);
}

function checkFields(fields: readonly FormField[], values: FormValues): string | null {
  for (const field of fields) {
    // A field the renderer hides is one the user cannot fill, so holding its
    // `required` flag against them rejects a submission they have no way to
    // complete — the error even names a field that is not on screen. Server-side
    // `validateFormValues` has skipped hidden fields since the gate-4-push bug;
    // this side was missed, which left the same shape failing in the browser
    // instead (11a-gate-4-push's `remoteUrl`, required behind an unticked `push`).
    if (!isFieldVisible(field, values)) continue;
    if (field.type === 'accordion') {
      for (const item of field.items) {
        const issue = checkFields(item.fields, values);
        if (issue) return issue;
      }
      continue;
    }
    if (!field.required) continue;
    const value = values[field.id];
    switch (field.type) {
      case 'checkbox':
        if (value !== true) return `${field.label} is required`;
        break;
      case 'multi-select':
      case 'directory-tree':
        if (!Array.isArray(value) || value.length === 0) return `${field.label} is required`;
        break;
      case 'number':
        if (value === '' || value === null || value === undefined || Number.isNaN(value as number))
          return `${field.label} is required`;
        break;
      default:
        if (typeof value !== 'string' || value.trim().length === 0)
          return `${field.label} is required`;
    }
  }
  return null;
}
