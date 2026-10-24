import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import type { UpgradePlanOutput } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { buildRtkAwarenessBlock } from '../src/step-engine/steps/onboarding/_rtk-templates.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import {
  PROVIDERS,
  REPO,
  ctxFor,
  seedProviders,
  seedRepository,
} from './support/upgrade-plan-fixtures.js';
import { recordWritten } from './support/upgrade-apply-record.js';
import { seedRollbackSnapshot } from './support/upgrade-rollback-snapshot.js';

const COLUMN = {
  projectInfo: { name: 'acme', framework: 'drupal', docroot: 'web' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: ['php-extended'],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: true }],
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  rtkEnabled: true,
  rtkChoiceRecorded: true,
};
const AGENTS_LEFT = '# Project\n\nOur notes.\n';
const AGENTS = `${AGENTS_LEFT}${buildRtkAwarenessBlock()}`;
const ROLLBACK = '00000000-0000-4000-8000-0000000000c2';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** One repository through upgrade 02 and rollback 04 and back to 01's offer. The fake sets no
 *  `generated_at`, so each action's rows are stamped in turn, as the database default would. */
async function cycle(agents: string, rtkOnAtApply: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-rtk-block-offer-cycle-'));
  dirs.push(root);
  await writeFile(join(root, 'AGENTS.md'), agents, 'utf8');
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
    taskEvents: schema.taskEvents,
  });
  const loose = fake as unknown as Parameters<typeof seedProviders>[0];
  seedProviders(loose, PROVIDERS);
  seedRepository(loose, {
    source: 'git_https',
    rtkEnabled: rtkOnAtApply,
    renderContext: COLUMN,
  });
  const { rtkChoiceRecorded: _recorded, ...snapshot } = COLUMN;
  seedRollbackSnapshot(fake, {
    userId: '00000000-0000-4000-8000-0000000000a1',
    repositoryId: REPO,
    taskId: '00000000-0000-4000-8000-0000000000c3',
    snapshot,
  });
  fake.insert(schema.taskSteps, {
    taskId: '00000000-0000-4000-8000-0000000000c1',
    stepId: '01-upgrade-plan',
    stepIndex: 1,
    round: 0,
    status: 'done',
    output: { rtkFollowsLive: true },
  });
  let clock = 1000;
  const stamp = async () => {
    clock += 1000;
    await fake.db
      .update(schema.onboardingArtifacts)
      .set({ generatedAt: new Date(clock) })
      .where(isNull(schema.onboardingArtifacts.generatedAt));
  };
  const plan = (over: Record<string, unknown>) =>
    ({
      repositoryId: REPO,
      ranBackfill: false,
      entries: [],
      counts: {},
      installedTemplateSetHash: null,
      currentTemplateSetHash: 'set',
      rtkFollowsLive: true,
      backfilledRows: 0,
      ...over,
    }) as unknown as UpgradePlanOutput;
  const apply = async (over: Record<string, unknown>, formValues: Record<string, unknown>) => {
    const out = await recordWritten(
      upgradeApplyStep.apply(ctxFor(loose, root), {
        detected: plan(over),
        formValues,
        iteration: 0,
        previousIterations: [],
      }),
    );
    await stamp();
    return out;
  };
  const rollBack = async (over: Record<string, unknown>) => {
    const out = await recordWritten(
      upgradeRollbackStep.apply({ ...ctxFor(loose, root), taskId: ROLLBACK }, {
        detected: {
          repositoryId: REPO,
          rolledBackFromTaskId: '00000000-0000-4000-8000-0000000000c1',
          targets: [],
          newArtifactsToUndo: [],
          unrecordedRewrites: [],
          warnings: [],
          ...over,
        },
        formValues: {},
        iteration: 0,
        previousIterations: [],
      } as never),
    );
    await stamp();
    return out;
  };
  const offered = async () =>
    (await upgradePlanStep.detect!(ctxFor(loose, root))).rtkBlockRestorable;
  const switchRtk = (on: boolean) =>
    fake.db
      .update(schema.repositories)
      .set({ rtkEnabled: on })
      .where(eq(schema.repositories.id, REPO));
  return {
    root,
    fake,
    apply,
    rollBack,
    offered,
    switchRtk,
    stamp,
    snapshot: { ...REFERENCE_CONTEXT, enabledCliProviders: COLUMN.enabledCliProviders },
  };
}

describe('the offer follows every action Haive takes on the block', () => {
  it('(a) a rollback of a restore leaves the block offered again', async () => {
    const c = await cycle(AGENTS_LEFT, true);
    c.fake.insert(schema.onboardingArtifacts, {
      userId: '00000000-0000-4000-8000-0000000000a1',
      repositoryId: REPO,
      taskId: '00000000-0000-4000-8000-0000000000c0',
      diskPath: 'AGENTS.md',
      templateId: 'rtk-block',
      templateKind: 'rtk-block',
      templateSchemaVersion: 1,
      templateContentHash: 'h',
      writtenHash: 'h',
      writtenContent: AGENTS,
      lastObservedDiskHash: 'l',
      userModified: false,
      formValuesSnapshot: null,
      sourceStepId: '02-upgrade-apply',
      source: 'backfill',
      haiveVersion: null,
      supersededAt: new Date(1),
      generatedAt: new Date(500),
      bundleItemId: null,
    });
    expect(await c.offered()).toEqual(['AGENTS.md']);
    const out = await c.apply(
      {
        renderCtxSnapshot: { ...c.snapshot, rtkEnabled: true },
        rtkBlockRestorable: ['AGENTS.md'],
      },
      { restoreRtkBlock: true },
    );
    expect(await c.offered()).toEqual([]);
    await c.rollBack({ rtkBlockRestores: out.rtkBlockRestores });
    expect(await c.offered()).toEqual(['AGENTS.md']);
    expect(
      c.fake.rows(schema.onboardingArtifacts).find((r) => r.taskId === ROLLBACK),
    ).toMatchObject({
      templateKind: 'rtk-block',
      diskPath: 'AGENTS.md',
      source: 'backfill',
      sourceStepId: '04-upgrade-rollback',
      writtenContent: AGENTS,
      lastObservedDiskHash: sha256Hex(normalizeContent(AGENTS_LEFT)),
      supersededAt: expect.any(Date),
    });
  });

  it('(b) a rollback of a strip, then a person deleting the block, offers nothing', async () => {
    const c = await cycle(AGENTS, false);
    const out = await c.apply({ renderCtxSnapshot: { ...c.snapshot, rtkEnabled: false } }, {});
    await c.switchRtk(true);
    expect(await c.offered()).toEqual(['AGENTS.md']);
    await c.rollBack({ rtkBlockStrips: out.rtkBlockStrips });
    await writeFile(join(c.root, 'AGENTS.md'), AGENTS_LEFT, 'utf8');
    expect(await c.offered()).toEqual([]);
  });
});

describe('a rollback that finds nothing to do records nothing', () => {
  it('a retried rollback of a restore adds no record once the block is out', async () => {
    const c = await cycle(AGENTS_LEFT, true);
    const out = await c.apply(
      {
        renderCtxSnapshot: { ...c.snapshot, rtkEnabled: true },
        rtkBlockRestorable: ['AGENTS.md'],
      },
      { restoreRtkBlock: true },
    );
    await c.rollBack({ rtkBlockRestores: out.rtkBlockRestores });
    const kinds = () => c.fake.rows(schema.onboardingArtifacts).map((r) => r.templateKind);
    const before = kinds().length;
    await c.rollBack({ rtkBlockRestores: out.rtkBlockRestores });
    expect(kinds()).toHaveLength(before);
  });
});
