import type { FormField, FormValues } from '@haive/shared';

type AccordionItem = Extract<FormField, { type: 'accordion' }>['items'][number];

/** An accordion item's summary, with a live `(n of m)` when the item names a
 *  counted field.
 *
 *  Counted from the CURRENT values rather than written into `title` by the step
 *  that built the form: `task_steps.form_schema` is stored and is not rebuilt
 *  while the step is parked, so a baked count states the selection at build time
 *  and then contradicts the boxes the user is ticking underneath it.
 *
 *  Anything else renders `title` verbatim — no declaration, a declaration naming
 *  a field this item does not carry, or one naming a field that is not a
 *  multi-select. Schemas persisted before the declaration existed are therefore
 *  unchanged, including the count they baked in. */
export function accordionItemTitle(item: AccordionItem, values: FormValues): string {
  if (!item.titleCountFieldId) return item.title;
  const counted = item.fields.find((f) => f.id === item.titleCountFieldId);
  if (!counted || counted.type !== 'multi-select') return item.title;
  const selected = values[counted.id];
  const count = Array.isArray(selected) ? selected.length : 0;
  return `${item.title} (${count} of ${counted.options.length})`;
}
