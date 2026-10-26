import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type {
  UpgradePlanEntry,
  UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import {
  RECORD_WRITE_TABLES,
  recordWritten,
  ROLLBACK_RECORD_WRITE_TABLES,
} from './support/upgrade-apply-record.js';

const beforeRewrite = vi.hoisted(() => ({
  run: null as null | (() => Promise<void>),
  parked: false,
}));
vi.mock('@haive/shared/fs-safe', async (importOriginal) => {
  const real = await importOriginal<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    rewriteFileIfNoFollow: async (...args: Parameters<typeof real.rewriteFileIfNoFollow>) => {
      const run = beforeRewrite.run;
      beforeRewrite.run = null;
      if (run) await run();
      if (beforeRewrite.parked) {
        beforeRewrite.parked = false;
        throw new real.ParkedFileError(args[1], `.parked-${args[1]}`, 'EEXIST');
      }
      return real.rewriteFileIfNoFollow(...args);
    },
  };
});

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const ONBOARDING = '00000000-0000-4000-8000-0000000000c2';

const CREATED = '.claude/agents/created.md';
const REINSTATED = '.claude/agents/reinstated.md';
const EDITED = '.claude/agents/edited.md';
const CLEAN = '.claude/agents/clean.md';
const ONBOARDING_SNAPSHOT = { from: 'onboarding' };
const OLD = 'OLD RENDER\n';
const MINE = 'MY OWN EDIT\n';
const NEW = 'NEW RENDER\n';
const OLD_REGION = `${CLI_RULES_START}\nOLD RULES\n${CLI_RULES_END}`;
const NEW_REGION = `${CLI_RULES_START}\nNEW RULES\n${CLI_RULES_END}`;
const MY_REGION = `${CLI_RULES_START}\nMY OWN RULES\n${CLI_RULES_END}`;
const hashOf = (text: string) => sha256Hex(normalizeContent(text));
const RAW_REGION = `${CLI_RULES_START}\r\nMY OWN RULES  \r\n\t\r\n\r\n\r\nmore\t\r\n${CLI_RULES_END}`;
const RAW_AGENTS = `# Notes\r\n\r\n${RAW_REGION}\r\n`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function entry(partial: Partial<UpgradePlanEntry> & Pick<UpgradePlanEntry, 'diskPath'>) {
  return {
    entryId: `e:${partial.diskPath}`,
    bucket: 'clean_update',
    templateId: `agent.${partial.diskPath}`,
    templateKind: 'agent',
    liveArtifactId: null,
    currentContent: null,
    newContent: NEW,
    baselineContent: null,
    currentHash: null,
    baselineWrittenHash: null,
    newContentHash: hashOf(NEW),
    baselineTemplateContentHash: null,
    currentTemplateContentHash: hashOf(NEW),
    templateSchemaVersion: 2,
    delta: null,
    ...partial,
  } satisfies UpgradePlanEntry;
}

/** A repository onboarded with OLD at two paths (one edited since), a third deleted since, and the
 *  rules region, and an upgrade that writes NEW over them and creates a file that was not there.
 *  Without `region`, AGENTS.md holds no rules region and no row records one. */
async function setup({
  region = true,
  regionEdited = false,
}: { region?: boolean; regionEdited?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-retry-'));
  dirs.push(root);
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  await writeFile(join(root, EDITED), MINE, 'utf8');
  await writeFile(join(root, CLEAN), OLD, 'utf8');
  await writeFile(
    join(root, 'AGENTS.md'),
    region ? `# Notes\n\n${regionEdited ? MY_REGION : OLD_REGION}\n` : '# Notes\n',
    'utf8',
  );
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    ...RECORD_WRITE_TABLES,
    ...ROLLBACK_RECORD_WRITE_TABLES,
  });
  const live = (diskPath: string, content: string, templateKind = 'agent') =>
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: ONBOARDING,
      diskPath,
      templateId: templateKind === 'agent' ? `agent.${diskPath}` : 'cli-rules',
      templateKind,
      templateSchemaVersion: 1,
      templateContentHash: hashOf(content),
      writtenHash: hashOf(content),
      writtenContent: content,
      lastObservedDiskHash: hashOf(content),
      formValuesSnapshot: ONBOARDING_SNAPSHOT,
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
    }).id as string;
  const editedRow = live(EDITED, OLD);
  const cleanRow = live(CLEAN, OLD);
  const reinstatedRow = live(REINSTATED, OLD);
  const rulesRow = region ? live('AGENTS.md', OLD_REGION, CLI_RULES_TEMPLATE_KIND) : null;
  const rulesEntry = {
    diskPath: 'AGENTS.md',
    templateId: 'cli-rules',
    templateKind: CLI_RULES_TEMPLATE_KIND,
    // The plan's render ends in a newline that upsertRegion trims when it writes the region.
    newContent: regionEdited ? `${NEW_REGION}\n` : NEW_REGION,
    newContentHash: hashOf(NEW_REGION),
    currentTemplateContentHash: hashOf(NEW_REGION),
  };
  const entries = [
    entry({ diskPath: CREATED, bucket: 'new_artifact' }),
    entry({
      diskPath: REINSTATED,
      bucket: 'user_deleted',
      liveArtifactId: reinstatedRow,
      baselineWrittenHash: hashOf(OLD),
      baselineTemplateContentHash: hashOf(OLD),
    }),
    entry({
      diskPath: EDITED,
      bucket: 'conflict',
      liveArtifactId: editedRow,
      currentContent: MINE,
      currentHash: hashOf(MINE),
      baselineWrittenHash: hashOf(OLD),
      baselineTemplateContentHash: hashOf(OLD),
    }),
    entry({
      diskPath: CLEAN,
      liveArtifactId: cleanRow,
      currentContent: OLD,
      currentHash: hashOf(OLD),
      baselineWrittenHash: hashOf(OLD),
      baselineTemplateContentHash: hashOf(OLD),
    }),
    region
      ? entry({
          ...rulesEntry,
          liveArtifactId: rulesRow,
          ...(regionEdited ? { bucket: 'conflict' as const } : {}),
          currentContent: regionEdited ? MY_REGION : OLD_REGION,
          currentHash: hashOf(regionEdited ? MY_REGION : OLD_REGION),
          baselineWrittenHash: hashOf(OLD_REGION),
          baselineTemplateContentHash: hashOf(OLD_REGION),
        })
      : entry({ ...rulesEntry, bucket: 'new_artifact' }),
  ];
  const plan = {
    repositoryId: REPO,
    ranBackfill: false,
    entries,
    counts: {
      unchanged: 0,
      clean_update: region ? 2 : 1,
      adopt: 0,
      conflict: 1,
      new_artifact: region ? 1 : 2,
      user_deleted: 1,
      obsolete: 0,
      foreign: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    backfilledRows: 0,
  } as UpgradePlanOutput;
  const formValues: Record<string, unknown> = {
    selectedUpdates: region ? [`e:${CLEAN}`, 'e:AGENTS.md'] : [`e:${CLEAN}`],
    selectedNew: region ? [`e:${CREATED}`] : [`e:${CREATED}`, 'e:AGENTS.md'],
    selectedReinstate: [`e:${REINSTATED}`],
  };
  const conflictFields = (upgradeApplyStep.form!({} as StepContext, plan)?.fields ?? []).filter(
    (f) => 'label' in f && String(f.label).startsWith('Conflict: '),
  ) as { id: string }[];
  for (const f of conflictFields) formValues[f.id] = 'apply_theirs';
  const noop = () => undefined;
  // A real apply owns a live task and an existing repository; these fixtures exercise the same fence.
  if (!fake.rows(schema.repositories).length)
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'acme',
      source: 'blank',
      rtkEnabled: false,
    });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding_upgrade',
    title: 'upgrade',
    status: 'running',
  });
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    throwIfCancelled: () => {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const apply = () =>
    recordWritten(
      upgradeApplyStep.apply(ctx, {
        detected: plan,
        formValues,
        iteration: 0,
        previousIterations: [],
      }),
    );
  const byId = (ids: readonly string[]) =>
    fake.rows(schema.onboardingArtifacts).filter((r) => ids.includes(r.id as string));
  const answerConflicts = (choice: string) => {
    for (const f of conflictFields) formValues[f.id] = choice;
  };
  return {
    root,
    fake,
    ctx,
    apply,
    byId,
    reinstatedRow,
    editedRow,
    rulesRow,
    answerConflicts,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** What a rollback of the upgrade would read from 02's record: what stood before at each path. */
function expectRecordsWhatStoodBefore(
  out: Awaited<ReturnType<Setup['apply']>>,
  { byId, reinstatedRow }: Setup,
) {
  expect(out.createdPaths).toEqual([
    { diskPath: CREATED, fileCreated: true, retiredRowId: null },
    { diskPath: REINSTATED, fileCreated: true, retiredRowId: reinstatedRow },
  ]);
  const retired = byId(out.retiredRowIds!);
  // Never a row this upgrade wrote: those hold what it wrote, not what stood before.
  expect(retired.filter((r) => r.taskId === TASK && r.source === 'upgrade')).toEqual([]);
  // 04's order: the latest retired first, and of those retired together the later written, which
  // the fake store keeps as insertion order.
  const newestAt = (path: string) =>
    retired
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.diskPath === path)
      .sort(
        (a, b) =>
          (b.r.supersededAt as Date).getTime() - (a.r.supersededAt as Date).getTime() || b.i - a.i,
      )[0]?.r;
  expect(retired.filter((r) => r.diskPath === CREATED)).toEqual([]);
  expect(newestAt(EDITED)?.writtenContent).toBe(MINE);
  // A path that held what its row records restores as that row did: its snapshot and version too.
  for (const path of [CLEAN, 'AGENTS.md']) {
    expect(newestAt(path)).toMatchObject({
      templateSchemaVersion: 1,
      formValuesSnapshot: ONBOARDING_SNAPSHOT,
    });
  }
  expect(newestAt(CLEAN)?.writtenContent).toBe(OLD);
  expect(normalizeContent(String(newestAt('AGENTS.md')?.writtenContent))).toBe(
    normalizeContent(OLD_REGION),
  );
}

describe('an upgrade apply retried after it failed part-way', () => {
  it('records what stood before on the first attempt', async () => {
    const s = await setup();
    const out = await s.apply();
    expect(await readFile(join(s.root, CREATED), 'utf8')).toBe(NEW);
    expectRecordsWhatStoodBefore(out, s);
  });

  it('still records it when the first attempt failed after its transaction', async () => {
    const s = await setup();
    jamRecordWrite(s);
    await expect(s.apply()).rejects.toThrow();
    s.fake.hooks.beforeLock = null;
    const out = await s.apply();
    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(NEW);
    expectRecordsWhatStoodBefore(out, s);
  });

  it('still records it when the first attempt failed inside its transaction', async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    expectRecordsWhatStoodBefore(await s.apply(), s);
  });

  it('records a rules region an attempt created in a file that stood without one', async () => {
    const s = await setup({ region: false });
    jamRecordWrite(s);
    await expect(s.apply()).rejects.toThrow();
    s.fake.hooks.beforeLock = null;
    const out = await s.apply();
    expect(out.createdPaths).toContainEqual({
      diskPath: 'AGENTS.md',
      fileCreated: false,
      retiredRowId: null,
    });
  });

  // A Retry clears the form, so the conflict can be answered the other way the second time.
  it("puts the person's bytes back when a retry keeps what a failed attempt overwrote", async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(NEW);

    s.answerConflicts('keep_ours');
    const out = await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(MINE);
    expect(out.writtenPaths ?? []).not.toContain(EDITED);
    expect(s.byId([s.editedRow])[0]).toMatchObject({
      writtenContent: MINE,
      lastObservedDiskHash: hashOf(MINE),
    });
  });

  it("puts the person's rules region back when a retry keeps what a failed attempt overwrote", async () => {
    const s = await setup({ regionEdited: true });
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toContain('NEW RULES');

    s.answerConflicts('keep_ours');
    await s.apply();

    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toBe(`# Notes\n\n${MY_REGION}\n`);
    expect(s.byId([s.rulesRow!])[0]?.lastObservedDiskHash).toBe(hashOf(MY_REGION));
  });

  it("records the rules region's exact bytes as what stood before, hashed normalized", async () => {
    const s = await setup({ regionEdited: true });
    await writeFile(join(s.root, 'AGENTS.md'), RAW_AGENTS, 'utf8');
    const out = await s.apply();
    const record = s
      .byId(out.retiredRowIds!)
      .find((r) => r.diskPath === 'AGENTS.md' && r.taskId === TASK);
    expect(record).toMatchObject({
      writtenContent: RAW_REGION,
      lastObservedDiskHash: hashOf(RAW_REGION),
      templateContentHash: hashOf(RAW_REGION),
    });
  });

  it('puts the rules region back byte for byte when a retry keeps what a failed attempt overwrote', async () => {
    const s = await setup({ regionEdited: true });
    await writeFile(join(s.root, 'AGENTS.md'), RAW_AGENTS, 'utf8');
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toContain('NEW RULES');

    s.answerConflicts('keep_ours');
    await s.apply();

    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toBe(RAW_AGENTS);
    expect(s.byId([s.rulesRow!])[0]).toMatchObject({
      writtenContent: RAW_REGION,
      lastObservedDiskHash: hashOf(RAW_REGION),
    });
  });

  it('rolls an overwritten rules region back byte for byte', async () => {
    const s = await setup({ regionEdited: true });
    await writeFile(join(s.root, 'AGENTS.md'), RAW_AGENTS, 'utf8');
    const out = await s.apply();
    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toContain('NEW RULES');
    const rows = s.fake.rows(schema.onboardingArtifacts);
    const upgradeRow = rows.find(
      (r) => r.diskPath === 'AGENTS.md' && r.taskId === TASK && r.source === 'upgrade',
    )!;
    const prior = s
      .byId(out.retiredRowIds!)
      .find((r) => r.diskPath === 'AGENTS.md' && r.taskId === TASK)!;
    const detected = {
      repositoryId: REPO,
      rolledBackFromTaskId: TASK,
      targets: [
        {
          diskPath: 'AGENTS.md',
          templateId: 'cli-rules',
          templateKind: CLI_RULES_TEMPLATE_KIND,
          templateSchemaVersion: 1,
          priorArtifactId: prior.id as string,
          upgradeArtifactId: upgradeRow.id as string,
          priorTemplateContentHash: prior.templateContentHash as string,
          priorWrittenHash: prior.writtenHash as string,
          priorWrittenContent: prior.writtenContent as string,
          priorFormValuesSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
        },
      ],
      newArtifactsToUndo: [],
      warnings: [],
    };

    await recordWritten(upgradeRollbackStep.apply(s.ctx, { detected } as never));

    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toBe(RAW_AGENTS);
  });

  it("keeps the plan's row live with the person's bytes when the failed attempt had committed", async () => {
    const s = await setup();
    jamRecordWrite(s);
    await expect(s.apply()).rejects.toThrow();
    s.fake.hooks.beforeLock = null;

    s.answerConflicts('keep_ours');
    await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(MINE);
    const live = s.fake
      .rows(schema.onboardingArtifacts)
      .filter((r) => r.diskPath === EDITED && r.supersededAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: s.editedRow, lastObservedDiskHash: hashOf(MINE) });
  });

  it('restores a pre-image once: a later retry after the Keep committed leaves a save alone', async () => {
    const s = await setup();
    jamRecordWrite(s);
    await expect(s.apply()).rejects.toThrow();
    s.answerConflicts('keep_ours');
    await expect(s.apply()).rejects.toThrow();
    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(MINE);
    s.fake.hooks.beforeLock = null;
    await writeFile(join(s.root, EDITED), NEW, 'utf8');

    await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(NEW);
  });

  it('consumes the pre-image even when a Keep found the path edited and restored nothing', async () => {
    const s = await setup();
    jamRecordWrite(s);
    await expect(s.apply()).rejects.toThrow();
    await writeFile(join(s.root, EDITED), 'SAVED SINCE\n', 'utf8');
    s.answerConflicts('keep_ours');
    await expect(s.apply()).rejects.toThrow();
    s.fake.hooks.beforeLock = null;
    await writeFile(join(s.root, EDITED), NEW, 'utf8');

    await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(NEW);
  });

  it("records the bytes a save left between the Keep's first read and its held rewrite", async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    s.answerConflicts('keep_ours');
    beforeRewrite.run = () => writeFile(join(s.root, EDITED), 'SAVED MEANWHILE\n', 'utf8');

    await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe('SAVED MEANWHILE\n');
    expect(s.byId([s.editedRow])[0]).toMatchObject({
      writtenContent: 'SAVED MEANWHILE\n',
      lastObservedDiskHash: hashOf('SAVED MEANWHILE\n'),
    });
  });

  it('records no Keep, and spends the pre-image, when the held rewrite finds no file to read', async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    s.answerConflicts('keep_ours');
    beforeRewrite.run = () => rm(join(s.root, EDITED));

    const out = await s.apply();

    expect(out.warnings).toContainEqual(expect.stringContaining('did not record keeping'));
    expect(s.byId([s.editedRow])[0]?.lastObservedDiskHash).not.toBe(hashOf(NEW));
    expect(
      s.fake
        .rows(schema.onboardingArtifacts)
        .some((r) => r.diskPath === EDITED && r.taskId === TASK && r.writtenContent === MINE),
    ).toBe(false);
    beforeRewrite.run = null;
  });

  it('spends the pre-image when the held rewrite parked the render and could not put it back', async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    s.answerConflicts('keep_ours');
    beforeRewrite.parked = true;

    const out = await s.apply();

    expect(out.warnings).toContainEqual(expect.stringContaining('did not put back'));
    expect(
      s.fake
        .rows(schema.onboardingArtifacts)
        .some((r) => r.diskPath === EDITED && r.taskId === TASK && r.writtenContent === MINE),
    ).toBe(false);
  });

  it("spends the pre-image even when the Keep's own transaction then fails", async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    s.answerConflicts('keep_ours');
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(MINE);
    await writeFile(join(s.root, EDITED), NEW, 'utf8');

    await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(NEW);
  });

  it("spends the pre-image when the path is already gone at the Keep's first read", async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    await rm(join(s.root, EDITED));
    s.answerConflicts('keep_ours');

    await s.apply();

    expect(
      s.fake
        .rows(schema.onboardingArtifacts)
        .some((r) => r.diskPath === EDITED && r.taskId === TASK && r.writtenContent === MINE),
    ).toBe(false);
  });

  // An unreadable read cannot tell a link or a directory from a transient I/O error, which proves
  // nothing about the bytes, so the person's only copy of their edits stays.
  it("fails, keeping the pre-image, when the Keep's first read cannot read the path", async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    await rm(join(s.root, EDITED));
    await mkdir(join(s.root, EDITED));
    s.answerConflicts('keep_ours');

    await expect(s.apply()).rejects.toThrow('could not read');

    expect(
      s.fake
        .rows(schema.onboardingArtifacts)
        .some((r) => r.diskPath === EDITED && r.taskId === TASK && r.writtenContent === MINE),
    ).toBe(true);
  });

  it('leaves a save that differs from the failed write only in line endings', async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    await writeFile(join(s.root, EDITED), NEW.replace(/\n/g, '\r\n'), 'utf8');
    s.answerConflicts('keep_ours');

    await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe(NEW.replace(/\n/g, '\r\n'));
  });

  it('spends every pre-image of the path, not only the newest, once a Keep settles it', async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    await writeFile(join(s.root, EDITED), 'SECOND EDIT\n', 'utf8');
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    s.answerConflicts('keep_ours');

    await s.apply();

    expect(
      s.fake
        .rows(schema.onboardingArtifacts)
        .filter((r) => r.diskPath === EDITED && r.taskId === TASK && r.source === 'backfill'),
    ).toEqual([]);
  });

  it('leaves a path alone that was edited after the failed attempt wrote it', async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    await writeFile(join(s.root, EDITED), 'SAVED SINCE\n', 'utf8');

    s.answerConflicts('keep_ours');
    await s.apply();

    expect(await readFile(join(s.root, EDITED), 'utf8')).toBe('SAVED SINCE\n');
  });

  it('never names a row something else retired meanwhile as the one it replaced', async () => {
    const s = await setup();
    failOneCommit(s);
    await expect(s.apply()).rejects.toThrow('commit refused');
    await s.fake.db
      .update(schema.onboardingArtifacts)
      .set({ supersededAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.onboardingArtifacts.id, s.reinstatedRow));
    const out = await s.apply();
    expect(out.createdPaths).toContainEqual({
      diskPath: REINSTATED,
      fileCreated: true,
      retiredRowId: null,
    });
    expect(out.retiredRowIds).not.toContain(s.reinstatedRow);
  });
});

function jamRecordWrite({ fake }: Setup) {
  fake.hooks.beforeLock = (key) => {
    if (key.includes('project-state')) throw new Error('database refused');
  };
}

function failOneCommit({ fake }: Setup) {
  let failed = false;
  fake.hooks.beforeCommit = () => {
    if (!failed) {
      failed = true;
      throw new Error('commit refused');
    }
  };
}
