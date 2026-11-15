import { describe, expect, it } from 'vitest';
import { upgradeRunConfigSchema } from '../src/schemas/run-config.js';
import { validateFormValues } from '../src/step-engine/schemas.js';
import type { FormSchema } from '../src/schemas/form.js';

describe('parked run-config upgrade', () => {
  it('appends a visible false checkbox without changing any existing form content', () => {
    const old: FormSchema = {
      title: 'Run',
      fields: [{ id: 'simplifyCode', type: 'checkbox', label: 'Simplify', default: true }],
      description: 'recommendation',
      submitLabel: 'Save',
    };
    const before = structuredClone(old);
    const upgraded = upgradeRunConfigSchema('06-run-config', old)!;
    expect(upgraded.fields.slice(0, -1)).toEqual(old.fields);
    expect(upgraded.fields.at(-1)).toMatchObject({
      id: 'autoActOnInsights',
      type: 'checkbox',
      default: false,
    });
    expect(validateFormValues(upgraded, {})).toEqual({
      success: true,
      data: { simplifyCode: true, autoActOnInsights: false },
    });
    expect(old).toEqual(before);
    expect(upgradeRunConfigSchema('06-run-config', upgraded)).toBe(upgraded);
    expect(upgradeRunConfigSchema('other', old)).toBe(old);
    expect(upgradeRunConfigSchema('06-run-config', null)).toBeNull();
  });
});

it('replaces the persisted hidden checkbox, including nested fields, once and accepts true', () => {
  const hidden = {
    id: 'autoActOnInsights',
    type: 'checkbox',
    label: 'Old',
    default: false,
    visibleWhen: { field: 'autoActOnInsights', in: [] },
  };
  for (const fields of [
    [hidden],
    [
      {
        id: 'advanced',
        type: 'accordion',
        items: [{ id: 'one', title: 'More', fields: [hidden] }],
      },
    ],
  ]) {
    const old = { title: 'Run', fields } as FormSchema;
    const upgraded = upgradeRunConfigSchema('06-run-config', old)!;
    expect(upgraded).not.toBe(old);
    expect(JSON.stringify(upgraded)).not.toContain('visibleWhen');
    expect(validateFormValues(upgraded, { autoActOnInsights: true })).toMatchObject({
      success: true,
      data: { autoActOnInsights: true },
    });
    expect(upgradeRunConfigSchema('06-run-config', upgraded)).toBe(upgraded);
    expect(JSON.stringify(old)).toContain('visibleWhen');
  }
});
