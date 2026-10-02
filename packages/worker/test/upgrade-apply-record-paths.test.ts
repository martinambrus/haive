import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { UpgradePlanOutput } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { appliedWrittenPaths } from '../src/step-engine/steps/onboarding-upgrade/03-upgrade-commit.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const RECORD_PATHS = ['.haive-data/state/format.json', '.haive-data/state/project/render.json'];

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** An upgrade with nothing to change, so that what 02 reports is what it did about the record. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-record-paths-'));
  dirs.push(root);
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    projectStateSync: schema.projectStateSync,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', source: 'blank' });
  const plan = {
    repositoryId: REPO,
    ranBackfill: false,
    entries: [],
    counts: {
      unchanged: 0,
      clean_update: 0,
      adopt: 0,
      conflict: 0,
      new_artifact: 0,
      user_deleted: 0,
      obsolete: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    backfilledRows: 0,
  } as UpgradePlanOutput;
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const apply = () =>
    upgradeApplyStep.apply(ctx, {
      detected: plan,
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
  return {
    root,
    fake,
    apply,
    column: () => fake.rows(schema.repositories)[0]!.renderContext ?? null,
    syncRows: () => fake.rows(schema.projectStateSync),
  };
}

describe('02 reports the record files it wrote', () => {
  it('lists both, and so the commit step stages both, when the record is written', async () => {
    const s = await setup();

    const out = await s.apply();

    expect(out.warnings).toEqual([]);
    expect(s.column()).not.toBeNull();
    expect(out.writtenPaths).toEqual(expect.arrayContaining(RECORD_PATHS));
    expect(appliedWrittenPaths(out)).toEqual(expect.arrayContaining(RECORD_PATHS));
  });

  it('lists both, and so the commit step stages both, when only the database half failed', async () => {
    const s = await setup();
    // The write's lock is refused; the one that clears the column goes through.
    let locks = 0;
    s.fake.hooks.beforeLock = () => {
      locks += 1;
      if (locks === 1) throw new Error('database refused');
    };

    const out = await s.apply();

    // The files stand on disk, where a later sync takes them as the intended context, while the
    // column and the sync row stayed as they were: the upgrade must still commit them.
    for (const rel of RECORD_PATHS) expect(existsSync(join(s.root, rel)), rel).toBe(true);
    expect(s.column()).toBeNull();
    expect(s.syncRows()).toEqual([]);
    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(out.writtenPaths).toEqual(expect.arrayContaining(RECORD_PATHS));
    expect(appliedWrittenPaths(out)).toEqual(expect.arrayContaining(RECORD_PATHS));
  });

  it('fails the step when the column cannot be cleared either', async () => {
    const s = await setup();
    s.fake.hooks.beforeLock = () => {
      throw new Error('database refused');
    };

    await expect(s.apply()).rejects.toThrow('database refused');
  });
});
