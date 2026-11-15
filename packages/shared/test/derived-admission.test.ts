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
