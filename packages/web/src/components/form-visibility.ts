import type { FormField, FormValues } from '@haive/shared';

/** Evaluate a field's optional `visibleWhen` predicate against the current form
 *  values. A field whose predicate fails is not rendered (or validated). Works
 *  for both top-level and accordion-nested fields since `values` is the whole
 *  form's value map. */
export function isFieldVisible(field: FormField, values: FormValues): boolean {
  const vw = field.visibleWhen;
  if (!vw) return true;
  const current = values[vw.field];
  if (vw.equals !== undefined) return current === vw.equals;
  if (vw.notEquals !== undefined) return current !== vw.notEquals;
  return true;
}
