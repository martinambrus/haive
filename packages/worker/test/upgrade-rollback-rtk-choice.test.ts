import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const UPGRADE_TASK = '00000000-0000-4000-8000-0000000000c2';
const ONBOARDING_TASK = '00000000-0000-4000-8000-0000000000c3';
const PRIOR_ROW = '00000000-0000-4000-8000-0000000000d1';
const REMOVED = '.claude/agents/gone.md';
const CREATED = '.claude/agents/new.md';
const KEPT = '.claude/agents/old.md';
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The context a rollback puts back, with the RTK value given, or none at all for `undefined`. */
const context = (rtkEnabled: boolean | undefined): Record<string, unknown> => {
  const { rtkEnabled: _own, ...rest } = REFERENCE_CONTEXT as unknown as Record<string, unknown>;
  return rtkEnabled === undefined ? rest : { ...rest, rtkEnabled };
};
/** What the repository holds before the rollback, from the upgrade's render: no case restores it. */
const UPGRADED = { ...context(true), framework: 'laravel' };

/** What the plan of the upgrade being undone stored. `null` is no plan stored at all, and a plan
 *  that names nothing is one stored before the question was recorded. */
type Plan = { rtkFollowsLive?: boolean } | null;

function database(plan: Plan) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateSync: schema.projectStateSync,
    taskSteps: schema.taskSteps,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    renderContext: { ...UPGRADED, rtkChoiceRecorded: true },
  });
  if (plan !== null) {
    fake.insert(schema.taskSteps, {
      taskId: UPGRADE_TASK,
      stepId: '01-upgrade-plan',
      stepIndex: 1,
      round: 0,
      title: 'Plan upgrade',
      status: 'done',
      output: { repositoryId: REPO, entries: [], ...plan },
    });
  }
  return fake;
}

async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'upgrade-rollback-rtk-choice-'));
  dirs.push(dir);
  return dir;
}

function stepContext(fake: ReturnType<typeof database>, repoPath: string): StepContext {
  const noop = () => undefined;
  return {
    db: fake.db,
    repoPath,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
}

/** An upgrade that removed a file the rollback puts back from a prior row, which carries the context
 *  the rollback restores. */
async function viaRestoredSnapshot(restoredRtk: boolean | undefined, plan: Plan) {
  const repoPath = await root();
  const fake = database(plan);
  const detected = {
    repositoryId: REPO,
    rolledBackFromTaskId: UPGRADE_TASK,
    targets: [
      {
        diskPath: REMOVED,
        templateId: 'agent.gone',
        templateKind: 'agent',
        templateSchemaVersion: 1,
        priorArtifactId: PRIOR_ROW,
        upgradeArtifactId: null,
        removed: true,
        priorTemplateContentHash: hashOf('GONE\n'),
        priorWrittenHash: hashOf('GONE\n'),
        priorWrittenContent: 'GONE\n',
        priorFormValuesSnapshot: context(restoredRtk),
      },
    ],
    newArtifactsToUndo: [],
    warnings: [],
  };
  const out = await upgradeRollbackStep.apply(stepContext(fake, repoPath), { detected } as never);
  return { fake, out, restored: context(restoredRtk) };
}

/** An upgrade that only created a file: nothing is restored from a prior row, so the context is the
 *  one the rows still live carry. */
async function viaLiveRows(liveRtk: boolean | undefined, plan: Plan) {
  const repoPath = await root();
  await mkdir(join(repoPath, '.claude/agents'), { recursive: true });
  await writeFile(join(repoPath, CREATED), 'HAIVE\n', 'utf8');
  const fake = database(plan);
  const row = (over: Record<string, unknown>) =>
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: hashOf('HAIVE\n'),
      writtenHash: hashOf('HAIVE\n'),
      ...over,
    });
  const upgradeRow = row({
    taskId: UPGRADE_TASK,
    diskPath: CREATED,
    templateId: 'agent.new',
    source: 'upgrade',
    formValuesSnapshot: UPGRADED,
    generatedAt: new Date('2026-02-01T00:00:00Z'),
  });
  row({
    taskId: ONBOARDING_TASK,
    diskPath: KEPT,
    templateId: 'agent.old',
    source: 'onboarding',
    formValuesSnapshot: context(liveRtk),
    generatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const detected = {
    repositoryId: REPO,
    rolledBackFromTaskId: UPGRADE_TASK,
    targets: [],
    newArtifactsToUndo: [
      {
        diskPath: CREATED,
        templateKind: 'agent',
        upgradeArtifactId: upgradeRow.id as string,
        writtenHash: hashOf('HAIVE\n'),
      },
    ],
    warnings: [],
  };
  const out = await upgradeRollbackStep.apply(stepContext(fake, repoPath), { detected } as never);
  return { fake, out, restored: context(liveRtk) };
}

const paths = [
  ['restores a prior row’s context', viaRestoredSnapshot],
  ['takes the context the rows still live carry', viaLiveRows],
] as const;

describe.each(paths)('the RTK choice of a rollback that %s', (_name, run) => {
  /** The column after the rollback, once it is certain the restored context was recorded at all. */
  const recordedAs = async (held: boolean | undefined, plan: Plan): Promise<unknown> => {
    const { fake, out, restored } = await run(held, plan);
    expect(out.warnings.filter((w) => w.includes('project state record'))).toEqual([]);
    expect(fake.rows(schema.projectStateSync)).toHaveLength(1);
    const column = fake.rows(schema.repositories)[0]!.renderContext;
    expect(column).toMatchObject(restored);
    return column;
  };

  it('is recorded when the plan of the upgrade found a choice and the context holds a value', async () => {
    const column = await recordedAs(false, { rtkFollowsLive: true });

    expect(column).toEqual({ ...context(false), rtkChoiceRecorded: true });
  });

  it('is not, when the plan found none, though the context holds a value', async () => {
    const column = await recordedAs(false, { rtkFollowsLive: false });

    expect(column).toEqual({ ...context(false), rtkChoiceRecorded: false });
  });

  it('is not, when the plan was stored before it recorded the question', async () => {
    const column = await recordedAs(true, {});

    expect(column).toEqual({ ...context(true), rtkChoiceRecorded: false });
  });

  it('is not, when the upgrade has no plan stored', async () => {
    const column = await recordedAs(true, null);

    expect(column).toEqual({ ...context(true), rtkChoiceRecorded: false });
  });

  it('is not, when the plan found a choice but the context holds no value', async () => {
    const column = await recordedAs(undefined, { rtkFollowsLive: true });

    expect(column).toEqual({ ...context(undefined), rtkChoiceRecorded: false });
  });
});
