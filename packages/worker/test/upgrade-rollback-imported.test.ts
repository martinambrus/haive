import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ imported: false, args: [] as unknown[] }));

vi.mock('@haive/shared/onboarding-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared/onboarding-admission')>()),
  ledgerImportedSince: async (...args: unknown[]) => {
    h.args = args;
    return h.imported;
  },
}));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { PROJECT_STATE_IMPORT_STEP_ID } from '@haive/shared/project-state';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  UpgradeRollbackImportedError,
  upgradeRollbackStep,
} from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { recordWritten, ROLLBACK_RECORD_WRITE_TABLES } from './support/upgrade-apply-record.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const PRIOR_TASK = '00000000-0000-4000-8000-0000000000c2';
const REL = '.claude/agents/new.md';
const COMPLETED = new Date('2026-10-01T00:00:00Z');

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

beforeEach(() => {
  h.imported = false;
  h.args = [];
});

function stubDb() {
  const results: unknown[][] = [
    [{ repositoryId: REPO }],
    [{ id: PRIOR_TASK, completedAt: COMPLETED }],
  ];
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit']) chain[m] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve, reject);
  return { select: () => chain };
}

function ctxOf(db: unknown, repoPath = '/nonexistent') {
  const noop = () => undefined;
  return {
    db,
    repoPath,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
}

describe('04 detect after an import', () => {
  it('refuses with the named error, asking about the prior upgrade completion date', async () => {
    h.imported = true;
    const db = stubDb();
    await expect(upgradeRollbackStep.detect!(ctxOf(db))).rejects.toBeInstanceOf(
      UpgradeRollbackImportedError,
    );
    expect(h.args).toEqual([db, REPO, COMPLETED]);
  });

  it('does not refuse for that reason when no import followed the upgrade', async () => {
    const err = await upgradeRollbackStep.detect!(ctxOf(stubDb())).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UpgradeRollbackImportedError);
  });
});

describe('04 apply restoring a retired import marker', () => {
  it('inserts it as a marker, not as a rollback row', async () => {
    const fake = createFakeDb({
      onboardingArtifacts: schema.onboardingArtifacts,
      repositories: schema.repositories,
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
      cliProviders: schema.cliProviders,
      ...ROLLBACK_RECORD_WRITE_TABLES,
    });
    fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
    const importedAt = new Date('2026-09-20T00:00:00Z');
    const upgradeRow = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: PRIOR_TASK,
      diskPath: REL,
      templateId: 'agent.new',
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: 'new',
      writtenHash: 'new',
      source: 'upgrade',
    });
    const retired = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: null,
      diskPath: REL,
      templateId: 'agent.new',
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: 'older-template',
      writtenHash: 'older-bytes',
      sourceStepId: PROJECT_STATE_IMPORT_STEP_ID,
      source: 'backfill',
      haiveVersion: '0.0.1-other',
      importedAt,
      formValuesSnapshot: REFERENCE_CONTEXT,
      supersededAt: new Date(),
    });
    const detected = {
      repositoryId: REPO,
      rolledBackFromTaskId: PRIOR_TASK,
      targets: [],
      newArtifactsToUndo: [
        {
          diskPath: REL,
          templateKind: 'agent',
          upgradeArtifactId: upgradeRow.id as string,
          writtenHash: 'new',
          retiredRowId: retired.id,
        },
      ],
      warnings: [],
    };
    const root = await mkdtemp(join(tmpdir(), 'upgrade-rollback-imported-'));
    dirs.push(root);
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'running',
      title: 'rollback',
    });
    await recordWritten(upgradeRollbackStep.apply(ctxOf(fake.db, root), { detected } as never));
    expect(fake.rows(schema.onboardingArtifacts).filter((r) => r.supersededAt == null)).toEqual([
      expect.objectContaining({
        diskPath: REL,
        taskId: null,
        source: 'backfill',
        sourceStepId: PROJECT_STATE_IMPORT_STEP_ID,
        importedAt,
        haiveVersion: '0.0.1-other',
      }),
    ]);
  });
});
