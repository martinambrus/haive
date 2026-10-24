import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { UpgradePlanOutput } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { buildRtkAwarenessBlock } from '../src/step-engine/steps/onboarding/_rtk-templates.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { recordWritten, ROLLBACK_RECORD_WRITE_TABLES } from './support/upgrade-apply-record.js';
import { seedRollbackSnapshot } from './support/upgrade-rollback-snapshot.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const ROLLBACK = '00000000-0000-4000-8000-0000000000c2';

const AGENTS_LEFT = '# Project\n\nOur notes.\n';
const AGENTS = `${AGENTS_LEFT}${buildRtkAwarenessBlock()}`;
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A repository whose AGENTS.md holds no RTK block, and an upgrade planned with RTK on that
 *  offers the block back. */
async function setup(agents: string = AGENTS_LEFT, offered: string[] = ['AGENTS.md']) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-rtk-block-restore-'));
  dirs.push(root);
  await writeFile(join(root, 'AGENTS.md'), agents, 'utf8');
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    taskEvents: schema.taskEvents,
    ...ROLLBACK_RECORD_WRITE_TABLES,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'blank',
    rtkEnabled: true,
    renderContext: null,
  });
  seedRollbackSnapshot(fake, {
    userId: USER,
    repositoryId: REPO,
    taskId: '00000000-0000-4000-8000-0000000000c3',
  });
  const noop = () => undefined;
  const ctxFor = (taskId: string) =>
    ({
      db: fake.db,
      repoPath: root,
      taskId,
      userId: USER,
      throwIfCancelled: () => {},
      logger: { info: noop, warn: noop, error: noop, debug: noop },
    }) as unknown as StepContext;
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
      foreign: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: { ...REFERENCE_CONTEXT, rtkEnabled: true } as unknown as Record<
      string,
      unknown
    >,
    rtkFollowsLive: true,
    rtkBlockRestorable: offered,
    backfilledRows: 0,
  } as UpgradePlanOutput;
  const apply = (formValues: Record<string, unknown>) =>
    recordWritten(
      upgradeApplyStep.apply(ctxFor(TASK), {
        detected: plan,
        formValues,
        iteration: 0,
        previousIterations: [],
      }),
    );
  const rollBack = (rtkBlockRestores: unknown) =>
    recordWritten(
      upgradeRollbackStep.apply(ctxFor(ROLLBACK), {
        detected: {
          repositoryId: REPO,
          rolledBackFromTaskId: TASK,
          targets: [],
          newArtifactsToUndo: [],
          unrecordedRewrites: [],
          warnings: [],
          rtkBlockRestores,
        },
        formValues: {},
        iteration: 0,
        previousIterations: [],
      } as never),
    );
  const read = (rel: string) => readFile(join(root, rel), 'utf8');
  const records = () =>
    fake.rows(schema.onboardingArtifacts).filter((r) => r.templateKind === 'rtk-block-restore');
  const seedRestore = async () => {
    await writeFile(join(root, 'AGENTS.md'), AGENTS, 'utf8');
    const row = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: TASK,
      diskPath: 'AGENTS.md',
      templateId: 'rtk-block-restore',
      templateKind: 'rtk-block-restore',
      templateSchemaVersion: 1,
      templateContentHash: hashOf(AGENTS_LEFT),
      writtenHash: hashOf(AGENTS_LEFT),
      writtenContent: AGENTS_LEFT,
      lastObservedDiskHash: hashOf(AGENTS),
      userModified: false,
      formValuesSnapshot: null,
      sourceStepId: '02-upgrade-apply',
      source: 'backfill',
      haiveVersion: null,
      supersededAt: new Date(),
      bundleItemId: null,
    });
    return [{ file: 'AGENTS.md', recordId: row.id as string }];
  };
  const form = () => upgradeApplyStep.form!({} as StepContext, plan);
  return { root, fake, apply, rollBack, read, records, seedRestore, form };
}

const TICKED = { restoreRtkBlock: true };
type Restores = { file: string; recordId: string }[] | undefined;
const restoresOf = (out: unknown) => (out as { rtkBlockRestores?: Restores }).rtkBlockRestores;

describe('an upgrade that offers the RTK block back', () => {
  it('shows an unticked box only when the plan offers the block back', async () => {
    const offeredForm = (await setup()).form();
    expect(offeredForm?.fields).toEqual([
      expect.objectContaining({ type: 'checkbox', id: 'restoreRtkBlock', default: false }),
    ]);
    expect((await setup(AGENTS_LEFT, [])).form()).toBeNull();
  });

  it('(c) leaves AGENTS.md byte-identical when the box is unticked', async () => {
    const { apply, read, records } = await setup();
    const out = await apply({ restoreRtkBlock: false });
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
    expect(restoresOf(out) ?? []).toEqual([]);
    expect(out.writtenPaths ?? []).not.toContain('AGENTS.md');
    expect(records()).toHaveLength(0);
    await apply({});
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
  });

  it('(d) appends the block and records the restore when the box is ticked', async () => {
    const { apply, read, records } = await setup();
    const out = await apply(TICKED);
    expect(await read('AGENTS.md')).toBe(AGENTS);
    const restores = restoresOf(out);
    expect(restores?.map((r) => r.file)).toEqual(['AGENTS.md']);
    expect(out.writtenPaths).toContain('AGENTS.md');
    expect(records().find((r) => r.id === restores?.[0]?.recordId)).toMatchObject({
      diskPath: 'AGENTS.md',
      taskId: TASK,
      source: 'backfill',
      writtenContent: AGENTS_LEFT,
      lastObservedDiskHash: hashOf(AGENTS),
      supersededAt: expect.any(Date),
    });
    expect(out.retiredRowIds).not.toContain(restores?.[0]?.recordId);
  });

  // A record whose write never landed would read as Haive's last action on the block.
  it('keeps no record when the file is saved while the restore judges it', async () => {
    const { root, fake, apply, records } = await setup();
    let saved = false;
    fake.hooks.beforeInsert = (table) => {
      if (table !== schema.onboardingArtifacts || saved) return;
      saved = true;
      writeFileSync(join(root, 'AGENTS.md'), 'saved meanwhile\n');
    };
    const out = await apply(TICKED);
    expect(restoresOf(out) ?? []).toEqual([]);
    expect(records()).toEqual([]);
  });

  it('(d) does nothing for a tick the plan did not offer', async () => {
    const { apply, read, records } = await setup(AGENTS_LEFT, []);
    const out = await apply(TICKED);
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
    expect(restoresOf(out) ?? []).toEqual([]);
    expect(records()).toHaveLength(0);
  });

  it('(e) reuses the earlier attempt record on a retry and does not append twice', async () => {
    const { apply, read, records } = await setup();
    const first = await apply(TICKED);
    const retried = await apply(TICKED);
    expect(await read('AGENTS.md')).toBe(AGENTS);
    expect(restoresOf(retried)).toEqual(restoresOf(first));
    expect(retried.writtenPaths).toContain('AGENTS.md');
    expect(records()).toHaveLength(1);
  });

  it('(e) takes no earlier record for a file edited since that attempt', async () => {
    const { root, apply } = await setup();
    await apply(TICKED);
    await writeFile(join(root, 'AGENTS.md'), `${AGENTS}Mine.\n`);
    const retried = await apply(TICKED);
    expect(restoresOf(retried) ?? []).toEqual([]);
    expect(retried.writtenPaths ?? []).not.toContain('AGENTS.md');
  });

  it('warns and never throws for a file that is not UTF-8', async () => {
    const { root, apply } = await setup();
    const bytes = Buffer.from([0x23, 0x20, 0xe9, 0x0a]);
    await writeFile(join(root, 'AGENTS.md'), bytes);
    const out = await apply(TICKED);
    expect((await readFile(join(root, 'AGENTS.md'))).equals(bytes)).toBe(true);
    expect(restoresOf(out) ?? []).toEqual([]);
    expect(out.warnings).toEqual([expect.stringMatching(/^did not put back .*AGENTS\.md/)]);
  });
});

describe('rolling back an upgrade that put the RTK block back', () => {
  it('(f) takes the restored block out again, and a retry counts it as taken out', async () => {
    const { seedRestore, rollBack, read } = await setup();
    const restores = await seedRestore();
    const undone = await rollBack(restores);
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
    expect(undone.revertedCount).toBe(1);
    expect(undone.warnings).toEqual([]);
    const retried = await rollBack(restores);
    expect(retried.revertedCount).toBe(1);
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
  });

  it('fails a rollback whose record cannot be written, and its retry writes the record', async () => {
    const { fake, seedRestore, rollBack, read } = await setup();
    const restores = await seedRestore();
    let failed = false;
    fake.hooks.beforeInsert = (table) => {
      if (table !== schema.onboardingArtifacts || failed) return;
      failed = true;
      throw new Error('db unavailable');
    };
    await expect(rollBack(restores)).rejects.toThrow('db unavailable');
    expect(await read('AGENTS.md')).toBe(AGENTS_LEFT);
    await rollBack(restores);
    const taken = fake
      .rows(schema.onboardingArtifacts)
      .filter((r) => r.templateKind === 'rtk-block' && r.taskId === ROLLBACK);
    expect(taken).toHaveLength(1);
  });

  it('(f) keeps a file edited since, and says why', async () => {
    const { root, seedRestore, rollBack, read } = await setup();
    const restores = await seedRestore();
    const edited = `${AGENTS}Mine.\n`;
    await writeFile(join(root, 'AGENTS.md'), edited);
    const undone = await rollBack(restores);
    expect(await read('AGENTS.md')).toBe(edited);
    expect(undone.revertedCount).toBe(0);
    expect(undone.warnings).toEqual([
      'did not take the RTK block back out of AGENTS.md: it was changed after the upgrade',
    ]);
  });

  it('(f) names a file removed since', async () => {
    const { root, seedRestore, rollBack } = await setup();
    const restores = await seedRestore();
    await rm(join(root, 'AGENTS.md'));
    const undone = await rollBack(restores);
    expect(undone.revertedCount).toBe(0);
    expect(undone.warnings).toEqual([
      'did not take the RTK block back out of AGENTS.md: it was removed after the upgrade',
    ]);
  });

  it('(f) names a restore whose record is gone rather than guess', async () => {
    const { seedRestore, rollBack, read } = await setup();
    await seedRestore();
    const undone = await rollBack([
      { file: 'AGENTS.md', recordId: '00000000-0000-4000-8000-0000000000ff' },
    ]);
    expect(await read('AGENTS.md')).toBe(AGENTS);
    expect(undone.warnings).toEqual([
      'cannot take the RTK block back out of AGENTS.md: no record of what it held',
    ]);
  });
});
