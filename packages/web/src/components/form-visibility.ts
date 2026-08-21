import type { FormField, FormValues } from '@haive/shared';
import { isFieldVisible as sharedIsFieldVisible } from '@haive/shared/schemas';

/** Evaluate a field's optional `visibleWhen` predicate against the current form
 *  values. A field whose predicate fails is not rendered (or validated).
 *
 *  Re-exported from @haive/shared/schemas rather than reimplemented: the renderer
 *  and `validateFormValues` MUST agree on what is visible. They did not, and a field
 *  hidden here stayed `required` server-side, which failed a task outright. Imported
 *  from the `/schemas` subpath, never the barrel — the barrel pulls ioredis into the
 *  browser bundle. */
export function isFieldVisible(field: FormField, values: FormValues): boolean {
  return sharedIsFieldVisible(field, values);
}
