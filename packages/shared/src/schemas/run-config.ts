import type { FormField, FormSchema } from './form.js';

/** Automatic insight execution is available; legacy parked schemas are upgraded below. */
export const INSIGHT_AUTO_ACTION_AVAILABLE = true;

export function autoActOnInsightsField(defaultValue = false): FormField {
  return {
    id: 'autoActOnInsights',
    type: 'checkbox',
    label: 'Automatically apply consequential insights (up to 3 rounds)',
    description:
      'Uses additional implementation, verification and review runs. Lesser items remain listed.',
    // An empty allow-list is false for every value; checkbox has no `hidden` property.
    ...(!INSIGHT_AUTO_ACTION_AVAILABLE
      ? { visibleWhen: { field: 'autoActOnInsights', in: [] } }
      : {}),
    default: INSIGHT_AUTO_ACTION_AVAILABLE && defaultValue === true,
  };
}

/** Upgrade persisted 06 forms at every reader; never rewrite answers or recommendation output. */
export function upgradeRunConfigSchema(
  stepId: string,
  schema: FormSchema | null,
): FormSchema | null {
  if (stepId !== '06-run-config' || !schema) return schema;
  let found = false;
  let changed = false;
  const upgrade = (field: FormField): FormField => {
    if (field.type === 'accordion') {
      const items = field.items.map((item) => {
        const fields = item.fields.map(upgrade);
        return fields.some((leaf, i) => leaf !== item.fields[i]) ? { ...item, fields } : item;
      });
      return items.some((item, i) => item !== field.items[i])
        ? ({ ...field, items } as FormField)
        : field;
    }
    if (field.id !== 'autoActOnInsights') return field;
    found = true;
    if (!INSIGHT_AUTO_ACTION_AVAILABLE || !field.visibleWhen) return field;
    changed = true;
    return autoActOnInsightsField(field.type === 'checkbox' && field.default === true);
  };
  const fields = schema.fields.map(upgrade);
  if (!found) return { ...schema, fields: [...fields, autoActOnInsightsField()] };
  return changed ? { ...schema, fields } : schema;
}
