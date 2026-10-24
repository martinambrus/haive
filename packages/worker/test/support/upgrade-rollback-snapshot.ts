import { schema } from '@haive/database';
import type { createFakeDb } from '@haive/database/testing';
import { REFERENCE_CONTEXT } from '../../src/step-engine/template-manifest.js';

/** A prior onboarding claim that survives the rollback and supplies the context its record writes. */
export function seedRollbackSnapshot(
  fake: Pick<ReturnType<typeof createFakeDb>, 'insert'>,
  {
    userId,
    repositoryId,
    taskId,
    snapshot = REFERENCE_CONTEXT,
  }: {
    userId: string;
    repositoryId: string;
    taskId: string;
    snapshot?: unknown;
  },
): void {
  fake.insert(schema.onboardingArtifacts, {
    userId,
    repositoryId,
    taskId,
    diskPath: '.claude/workflow-config.json',
    templateId: 'workflow-config',
    templateKind: 'workflow-config',
    templateSchemaVersion: 2,
    templateContentHash: 'a'.repeat(64),
    writtenHash: 'a'.repeat(64),
    formValuesSnapshot: snapshot,
    source: 'onboarding',
    sourceStepId: '07-generate-files',
    generatedAt: new Date('2026-01-01T00:00:00Z'),
  });
}
