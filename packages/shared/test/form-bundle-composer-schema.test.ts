import { describe, it, expect } from 'vitest';
import { validateFormValues } from '../src/step-engine/schemas.js';
import type { FormSchema } from '../src/schemas/form.js';

// `coerceField` rebuilds the validated object field by field, so a field type it does
// not name is dropped while still reporting success:true. MEASURED end to end on a live
// onboarding: the browser posted {"bundles":[{...}]}, the API stored it and logged
// fieldCount 1, then the runner re-validated, wrote {} back over the row, and 06_3's
// apply recorded bundleIds: [] — the step showed no bundle and could raise no
// syncing/failed warning for one. Identical to the `directory-tree` regression.
const schema: FormSchema = {
  title: 'Custom bundles',
  fields: [
    {
      type: 'bundle-composer',
      id: 'bundles',
      label: 'Bundles for this repository',
      initialBundles: [],
      allowAddZip: true,
      allowAddGit: true,
      credentialOptions: [],
    },
  ],
};

const entry = {
  id: '12024997-14d6-4313-a888-e502dba59174',
  name: 'repro-bundle',
  sourceType: 'zip',
  status: 'active',
  itemCount: 3,
};

describe('validateFormValues — bundle-composer', () => {
  it('keeps the composer selection instead of silently dropping it', () => {
    const r = validateFormValues(schema, { bundles: [entry] });
    expect(r.success).toBe(true);
    expect(r.success && r.data.bundles).toEqual([entry]);
  });

  // 06_3's extractBundleIdsFromValues reads both shapes, so the validator must too.
  it('accepts a bare id string', () => {
    const r = validateFormValues(schema, { bundles: ['abc'] });
    expect(r.success && r.data.bundles).toEqual(['abc']);
  });

  // A list field's empty state is an empty list, not null — apply reads it with
  // Array.isArray, and null would read as "no field" rather than "no bundles".
  it('defaults to an empty list when the field was never touched', () => {
    const r = validateFormValues(schema, {});
    expect(r.success && r.data.bundles).toEqual([]);
  });

  it('keeps an explicitly empty list', () => {
    const r = validateFormValues(schema, { bundles: [] });
    expect(r.success && r.data.bundles).toEqual([]);
  });

  // Failing loudly matters more than coercing: a dropped id is invisible, and the
  // silent strip is the whole reason this case exists.
  it('rejects an entry with no usable id', () => {
    const r = validateFormValues(schema, { bundles: [{ nope: 1 }] });
    expect(r.success).toBe(false);
    expect(!r.success && r.issues.join()).toMatch(/non-empty id/);
  });

  it('rejects a non-array value', () => {
    const r = validateFormValues(schema, { bundles: 'x' });
    expect(r.success).toBe(false);
    expect(!r.success && r.issues.join()).toMatch(/expected an array/);
  });
});
