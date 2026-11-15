import { describe, expect, it } from 'vitest';
import { upgradeRunConfigSchema } from '../src/schemas/run-config.js';
import { validateFormValues } from '../src/step-engine/schemas.js';
import type { FormSchema } from '../src/schemas/form.js';

describe('parked run-config upgrade', () => {
  it('appends a hidden false checkbox without changing any existing form content', () => {
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
      visibleWhen: { field: 'autoActOnInsights', in: [] },
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
