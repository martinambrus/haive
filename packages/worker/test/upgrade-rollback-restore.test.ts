import { describe, expect, it } from 'vitest';
import { resolveRollbackRestore } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';

function target(overrides: Record<string, unknown> = {}) {
  return {
    diskPath: '.claude/workflow-config.json',
    templateId: 'workflow-config',
    templateKind: 'workflow-config',
    templateSchemaVersion: 1,
    priorArtifactId: 'prior-1',
    upgradeArtifactId: 'upg-1',
    priorTemplateContentHash: 'hash-prior',
    priorWrittenHash: 'wh-prior',
    priorWrittenContent: '{"old":true}',
    priorFormValuesSnapshot: {},
    ...overrides,
  } as Parameters<typeof resolveRollbackRestore>[0];
}

function rendering(overrides: Record<string, unknown> = {}) {
  return {
    content: '{"new":true}',
    writtenHash: 'wh-new',
    templateContentHash: 'hash-new',
    templateSchemaVersion: 2,
    templateId: 'workflow-config',
    templateKind: 'workflow-config',
    ...overrides,
  } as Parameters<typeof resolveRollbackRestore>[1];
}

describe('resolveRollbackRestore', () => {
  it('restores stored content even when schema_version bumped (the regression)', () => {
    // prior sv1, current rendering sv2 — must still restore the stored bytes
    // instead of skipping on the schema mismatch.
    const d = resolveRollbackRestore(target(), rendering({ templateSchemaVersion: 2 }));
    expect('plan' in d).toBe(true);
    if ('plan' in d) {
      expect(d.plan.content).toBe('{"old":true}');
      expect(d.plan.schemaVersion).toBe(1);
      expect(d.warning).toBeUndefined();
    }
  });

  it('restores stored content even when the template is gone from the manifest', () => {
    const d = resolveRollbackRestore(target(), undefined);
    expect('plan' in d).toBe(true);
    if ('plan' in d) expect(d.plan.content).toBe('{"old":true}');
  });

  it('skips a legacy row (no stored content) when schema_version mismatches', () => {
    const d = resolveRollbackRestore(
      target({ priorWrittenContent: null }),
      rendering({ templateSchemaVersion: 2 }),
    );
    expect('skip' in d).toBe(true);
    if ('skip' in d) expect(d.skip).toMatch(/schema_version mismatch/);
  });

  it('re-renders a legacy row from current code when schema_version matches', () => {
    const d = resolveRollbackRestore(
      target({ priorWrittenContent: null }),
      rendering({ templateSchemaVersion: 1, templateContentHash: 'hash-prior' }),
    );
    expect('plan' in d).toBe(true);
    if ('plan' in d) {
      expect(d.plan.content).toBe('{"new":true}');
      expect(d.warning).toBeUndefined();
    }
  });

  it('warns about drift when re-rendering a legacy row with a different content hash', () => {
    const d = resolveRollbackRestore(
      target({ priorWrittenContent: null }),
      rendering({ templateSchemaVersion: 1, templateContentHash: 'hash-different' }),
    );
    expect('plan' in d).toBe(true);
    if ('plan' in d) expect(d.warning).toMatch(/content drifted/);
  });

  it('skips a legacy row when the template is no longer in the manifest', () => {
    const d = resolveRollbackRestore(target({ priorWrittenContent: null }), undefined);
    expect('skip' in d).toBe(true);
    if ('skip' in d) expect(d.skip).toMatch(/no longer in manifest/);
  });
});
