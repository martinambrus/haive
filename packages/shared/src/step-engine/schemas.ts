import type { FormField, FormSchema } from '../schemas/form.js';

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
    const raw = input[field.id];
    const coerced = coerceField(field, raw, issues);
    if (coerced !== undefined) data[field.id] = coerced;
  }
  if (issues.length > 0) return { success: false, issues };
  return { success: true, data };
}

function coerceField(field: FormField, raw: unknown, issues: string[]): unknown {
  const present = raw !== undefined && raw !== null && raw !== '';
  if (!present) {
    if (field.required) {
      issues.push(`${field.id}: required`);
      return undefined;
    }
    return defaultFor(field);
  }
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'select-with-text':
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
    default:
      return undefined;
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
      return 'default' in field ? (field.default ?? null) : null;
    case 'multi-select':
      return field.defaults ?? [];
    case 'checkbox':
      return field.default ?? false;
    case 'number':
      return field.default ?? null;
    case 'file-upload':
      return null;
    default:
      return null;
  }
}
