import type { FormField, FormSchema } from './form.js';

/** Flip only when automatic insight execution ships. Hidden forms always offer false. */
export const INSIGHT_AUTO_ACTION_AVAILABLE = false;

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
  const hasField = schema.fields.some((field) =>
    field.type === 'accordion'
      ? field.items.some((item) => item.fields.some((leaf) => leaf.id === 'autoActOnInsights'))
      : field.id === 'autoActOnInsights',
  );
  return hasField ? schema : { ...schema, fields: [...schema.fields, autoActOnInsightsField()] };
}
