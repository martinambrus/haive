import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { inspectDerivedDefinition } from '../src/modularity-server/derived-task-types.js';
import { parseDerivedRunPlan } from '../src/modularity/derived-task-types.js';
import { replacementAdmissionFixture } from './derived-admission-fixtures.js';
it('refuses an unparseable replace-then-remove pin during admission', () => {
  const { definition, base, catalog, payload } = replacementAdmissionFixture();
  const result = inspectDerivedDefinition(
    { ...definition, changes: [...definition.changes, { remove: payload }] },
    base,
    catalog,
  );
  expect(result.plan).toBeNull();
  expect(result.issues).toContainEqual({ kind: 'invalid-derived-run-plan' });
});
it('keeps v1 catalog fingerprints byte-identical to the base algorithm', () => {
  const { definition, base, catalog } = replacementAdmissionFixture();
  const expected = createHash('sha256')
    .update(
      JSON.stringify({
        rows: [...catalog.orderedRows].sort((a, b) => a.stepId.localeCompare(b.stepId)),
        entries: [...catalog.composable].sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest('hex');
  for (const changes of [[], [{ remove: 'old-step' }]]) {
    const result = inspectDerivedDefinition({ ...definition, changes }, base, catalog);
    expect(result.plan?.version).toBe(1);
    expect(result.catalogFingerprint).toBe(expected);
  }
});
it('shares unchanged effective declarations instead of repeating them on every candidate', () => {
  const { definition, base, catalog, payload } = replacementAdmissionFixture();
  const result = inspectDerivedDefinition(definition, base, catalog);
  expect(result.issues).toEqual([]);
  const plan = parseDerivedRunPlan(result.plan);
  expect(plan.version).toBe(2);
  for (const candidate of plan.candidates) {
    expect(candidate.effectiveEntries?.map((e) => e.stepId)).toEqual(
      candidate.roleBindings?.['08c-code-review'] ? [payload] : [],
    );
  }
});
it.each([1, 2])(
  'keeps v%s plans and fingerprints byte-identical when the catalog gains data declarations',
  async (version) => {
    const { SPEC_ROLES, STEP_ROLE_REGISTRY } =
      await import('../src/step-engine/output-contracts.js');
    const f = replacementAdmissionFixture();
    const definition = { ...f.definition, changes: version === 1 ? [] : f.definition.changes };
    const baseline = inspectDerivedDefinition(definition, f.base, f.catalog);
    expect(baseline.plan?.version).toBe(version);
    const entries = new Map(
      [...f.catalog.composable].map(([id, e]) => [
        id,
        {
          ...e,
          providesRoles: [
            { role: SPEC_ROLES.checked, contract: STEP_ROLE_REGISTRY[SPEC_ROLES.checked].contract },
          ],
          consumesRoles: [
            {
              input: 'spec',
              role: SPEC_ROLES.draft,
              contract: STEP_ROLE_REGISTRY[SPEC_ROLES.draft].contract,
              optional: true,
            },
          ],
        },
      ]),
    );
    const enriched = inspectDerivedDefinition(definition, f.base, {
      ...f.catalog,
      composable: entries,
    });
    expect(JSON.stringify(enriched.plan)).toBe(JSON.stringify(baseline.plan));
    expect(enriched.catalogFingerprint).toBe(baseline.catalogFingerprint);
  },
);
