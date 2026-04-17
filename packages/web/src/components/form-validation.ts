import type { FormField, FormSchema } from '@haive/shared';

export type FormValues = Record<string, unknown>;

export function validateRequired(schema: FormSchema, values: FormValues): string | null {
  return checkFields(schema.fields, values);
}

function checkFields(fields: readonly FormField[], values: FormValues): string | null {
  for (const field of fields) {
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
