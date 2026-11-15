import type { FormField, FormSchema } from './form.js';

/** Automatic insight execution is available; legacy parked schemas are upgraded below. */
export const INSIGHT_AUTO_ACTION_AVAILABLE = true;

export function autoActOnInsightsField(
  defaultValue = false,
  available = INSIGHT_AUTO_ACTION_AVAILABLE,
): FormField {
  return {
    id: 'autoActOnInsights',
    type: 'checkbox',
    label: 'Automatically apply consequential insights (up to 3 rounds)',
    description:
      'Uses additional implementation, verification and review runs. Lesser items remain listed.',
    // An empty allow-list is false for every value; checkbox has no `hidden` property.
    ...(!available ? { visibleWhen: { field: 'autoActOnInsights', in: [] } } : {}),
    default: available && defaultValue === true,
  };
}

/**
 * Upgrade persisted 06 forms at every reader; never rewrite answers or recommendation output.
 * Both directions: a hidden field becomes visible while execution is available, and a visible
 * one is hidden again when it is switched off, so a parked form never offers a dead setting.
 */
export function upgradeRunConfigSchema(
  stepId: string,
  schema: FormSchema | null,
  available = INSIGHT_AUTO_ACTION_AVAILABLE,
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
    if (available === !field.visibleWhen) return field;
    changed = true;
    return autoActOnInsightsField(field.type === 'checkbox' && field.default === true, available);
  };
  const fields = schema.fields.map(upgrade);
  if (!found) return { ...schema, fields: [...fields, autoActOnInsightsField(false, available)] };
  return changed ? { ...schema, fields } : schema;
}
