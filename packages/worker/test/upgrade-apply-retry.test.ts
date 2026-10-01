import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
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
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

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
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

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
async function setup({ region = true }: { region?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-retry-'));
  const outside = await mkdtemp(join(tmpdir(), 'upgrade-apply-retry-out-'));
  dirs.push(root, outside);
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  await writeFile(join(root, EDITED), MINE, 'utf8');
  await writeFile(join(root, CLEAN), OLD, 'utf8');
  await writeFile(
    join(root, 'AGENTS.md'),
    region ? `# Notes\n\n${OLD_REGION}\n` : '# Notes\n',
    'utf8',
  );
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
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
    newContent: NEW_REGION,
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
          currentContent: OLD_REGION,
          currentHash: hashOf(OLD_REGION),
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
  const conflictField = upgradeApplyStep.form!({} as StepContext, plan)?.fields.find(
    (f) => 'label' in f && f.label === `Conflict: ${EDITED}`,
  );
  formValues[(conflictField as { id: string }).id] = 'apply_theirs';
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
      formValues,
      iteration: 0,
      previousIterations: [],
    });
  const byId = (ids: readonly string[]) =>
    fake.rows(schema.onboardingArtifacts).filter((r) => ids.includes(r.id as string));
  return { root, outside, fake, apply, byId, reinstatedRow };
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
    await symlink(s.outside, join(s.root, '.haive'));
    await expect(s.apply()).rejects.toThrow();
    await rm(join(s.root, '.haive'));
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
    await symlink(s.outside, join(s.root, '.haive'));
    await expect(s.apply()).rejects.toThrow();
    await rm(join(s.root, '.haive'));
    const out = await s.apply();
    expect(out.createdPaths).toContainEqual({
      diskPath: 'AGENTS.md',
      fileCreated: false,
      retiredRowId: null,
    });
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

function failOneCommit({ fake }: Setup) {
  let failed = false;
  fake.hooks.beforeCommit = () => {
    if (!failed) {
      failed = true;
      throw new Error('commit refused');
    }
  };
}
