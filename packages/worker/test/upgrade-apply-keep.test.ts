import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type {
  UpgradePlanEntry,
  UpgradePlanOutput,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import {
  classifyApplyAction,
  upgradeApplyStep,
  type ApplySelections,
} from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

// The keep choice (harness-amendment-227.md section 2): 02's form offers an obsolete Haive file the
// choice to be kept and no longer tracked, and the apply supersedes its row and touches nothing else.

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const ONBOARDING = '00000000-0000-4000-8000-0000000000c2';
const OLD = '.claude/agents/old.md';
const OLDER = '.claude/agents/older.md';
const KEEP_FIELD = 'selectedObsoleteUntracks';
const hashOf = (text: string) => sha256Hex(normalizeContent(text));
const bodyOf = (diskPath: string) => `${diskPath} as Haive wrote it\n`;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A plan entry for a file Haive no longer renders, the way 01 describes one that still holds what its row records. */
function obsolete(diskPath: string, over: Partial<UpgradePlanEntry> = {}): UpgradePlanEntry {
  const body = bodyOf(diskPath);
  return {
    entryId: `e:${diskPath}`,
    bucket: 'obsolete',
    templateId: 'agent.old',
    templateKind: 'agent',
    diskPath,
    liveArtifactId: null,
    currentContent: body,
    newContent: null,
    baselineContent: body,
    currentHash: hashOf(body),
    baselineWrittenHash: hashOf(body),
    newContentHash: null,
    baselineTemplateContentHash: hashOf(body),
    currentTemplateContentHash: null,
    templateSchemaVersion: 1,
    delta: null,
    ...over,
  };
}

const planOf = (entries: UpgradePlanEntry[]): UpgradePlanOutput =>
  ({
    repositoryId: REPO,
    ranBackfill: false,
    entries,
    counts: {
      unchanged: 0,
      clean_update: 0,
      adopt: 0,
      conflict: 0,
      new_artifact: 0,
      user_deleted: 0,
      obsolete: entries.length,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    backfilledRows: 0,
  }) as UpgradePlanOutput;

interface KeepField {
  type: string;
  label: string;
  defaults?: string[];
  options?: { value: string; label: string }[];
}
const keepFieldOf = (plan: UpgradePlanOutput): KeepField | undefined =>
  (upgradeApplyStep.form!({} as StepContext, plan)?.fields as { id: string }[] | undefined)?.find(
    (f) => f.id === KEEP_FIELD,
  ) as KeepField | undefined;

describe('O1: 02 offers the keep choice for an obsolete Haive file', () => {
  it('lists the entry, unticked, in a multi-select that says what it does', () => {
    const entry = obsolete(OLD, { liveArtifactId: 'live-1' });

    const field = keepFieldOf(planOf([entry]));

    expect(field?.type).toBe('multi-select');
    expect(field?.label).toBe('Keep these files, and stop tracking them');
    expect(field?.options?.map((o) => o.value)).toEqual([entry.entryId]);
    expect(field?.defaults).toEqual([]);
  });

  it('lists every such entry and no other', () => {
    const entries = [
      obsolete(OLD, { liveArtifactId: 'live-1' }),
      obsolete(OLDER, { liveArtifactId: 'live-2' }),
      obsolete('.claude/agents/custom.md', {
        templateId: 'custom.bundle-1.item-1',
        liveArtifactId: 'live-3',
      }),
      obsolete('.claude/agents/unread.md', { liveArtifactId: 'live-4', unread: 'oversized' }),
      obsolete('.claude/agents/unrecorded.md', { liveArtifactId: null }),
    ];

    const field = keepFieldOf(planOf(entries));

    expect(field?.options?.map((o) => o.label)).toEqual([OLD, OLDER]);
    expect(field?.defaults).toEqual([]);
  });

  it.each([
    ['a bundle item, which 02 untracks already', { templateId: 'custom.bundle-1.item-1' }],
    ['an entry the plan did not read', { unread: 'oversized' as const }],
    ['an entry no row records', { liveArtifactId: null }],
  ])('has no field when the only obsolete entry is %s', (_what, over) => {
    const entry = obsolete(OLD, { liveArtifactId: 'live-1', ...over });

    expect(keepFieldOf(planOf([entry]))).toBeUndefined();
  });

  it('has no field when nothing is obsolete', () => {
    expect(keepFieldOf(planOf([]))).toBeUndefined();
  });
});

/** An upgrade of a repository holding live rows for obsolete files that are on disk as Haive wrote them. */
async function upgrade(paths: string[], templateId = 'agent.old') {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-keep-'));
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
  const entries: UpgradePlanEntry[] = [];
  const rows: Record<string, string> = {};
  for (const diskPath of paths) {
    const body = bodyOf(diskPath);
    await mkdir(join(root, '.claude/agents'), { recursive: true });
    await writeFile(join(root, diskPath), body);
    const row = fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: ONBOARDING,
      diskPath,
      templateId,
      templateKind: templateId.startsWith('custom.') ? 'custom-agent' : 'agent',
      templateSchemaVersion: 1,
      templateContentHash: hashOf(body),
      writtenHash: hashOf(body),
      writtenContent: body,
      lastObservedDiskHash: hashOf(body),
      userModified: false,
      formValuesSnapshot: REFERENCE_CONTEXT,
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
      haiveVersion: null,
      generatedAt: new Date(1000),
      supersededAt: null,
      bundleItemId: null,
    });
    rows[diskPath] = row.id as string;
    entries.push(obsolete(diskPath, { templateId, liveArtifactId: row.id as string }));
  }
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const plan = planOf(entries);
  const apply = (formValues: Record<string, unknown>) =>
    upgradeApplyStep.apply(ctx, {
      detected: plan,
      formValues,
      iteration: 0,
      previousIterations: [],
    });
  const untracked = (out: unknown) =>
    (out as { untrackedRowIds?: string[] }).untrackedRowIds ?? null;
  const live = (diskPath: string) =>
    fake
      .rows(schema.onboardingArtifacts)
      .some((r) => r.id === rows[diskPath] && r.supersededAt === null);
  return { root, plan, entries, rows, apply, untracked, live };
}

describe('O2: a file picked to be kept', () => {
  it('has its row superseded, its bytes left as they are, and nothing deleted', async () => {
    const u = await upgrade([OLD]);

    const out = await u.apply({ [KEEP_FIELD]: [u.entries[0]!.entryId] });

    expect(u.live(OLD)).toBe(false);
    expect(await readFile(join(u.root, OLD), 'utf8')).toBe(bodyOf(OLD));
    expect(out.deletedCount).toBe(0);
    expect(out.deletedPaths ?? []).toEqual([]);
    expect(out.skippedCount).toBe(1);
    expect(u.untracked(out)).toEqual([u.rows[OLD]]);
    expect(out.retiredRowIds).toContain(u.rows[OLD]);
  });

  it('is listed again by a retry that finds its row already superseded', async () => {
    const u = await upgrade([OLD]);
    const values = { [KEEP_FIELD]: [u.entries[0]!.entryId] };
    await u.apply(values);

    const again = await u.apply(values);

    expect(u.untracked(again)).toEqual([u.rows[OLD]]);
    expect(await readFile(join(u.root, OLD), 'utf8')).toBe(bodyOf(OLD));
  });

  it('is not picked by default: an unticked entry stays tracked and on disk', async () => {
    const u = await upgrade([OLD]);

    const out = await u.apply({ [KEEP_FIELD]: [] });

    expect(u.live(OLD)).toBe(true);
    expect(await readFile(join(u.root, OLD), 'utf8')).toBe(bodyOf(OLD));
    expect(out.skippedCount).toBe(1);
    expect(u.untracked(out) ?? []).toEqual([]);
  });
});

describe('O3: a file picked both to be removed and to be kept', () => {
  it('is removed, and the file picked only to be kept beside it still is', async () => {
    const u = await upgrade([OLD, OLDER]);
    const [removed, kept] = u.entries;

    const out = await u.apply({
      selectedObsoleteRemovals: [removed!.entryId],
      [KEEP_FIELD]: [removed!.entryId, kept!.entryId],
    });

    expect(await readFile(join(u.root, OLD), 'utf8').catch(() => null)).toBeNull();
    expect(out.deletedPaths).toEqual([OLD]);
    expect(u.live(OLD)).toBe(false);
    expect(await readFile(join(u.root, OLDER), 'utf8')).toBe(bodyOf(OLDER));
    expect(u.live(OLDER)).toBe(false);
    expect(u.untracked(out)).toEqual([u.rows[OLDER]]);
  });
});

describe('a bundle item that is gone, which 02 untracks without being asked', () => {
  const GONE = 'custom.bundle-1.00000000-0000-4000-8000-0000000000e1';

  it('is still untracked by default, its file left where it is', async () => {
    const u = await upgrade([OLD], GONE);

    await u.apply({});

    expect(u.live(OLD)).toBe(false);
    expect(await readFile(join(u.root, OLD), 'utf8')).toBe(bodyOf(OLD));
  });

  it('is listed with the rows 02 untracked, as a Haive file picked to be kept is', async () => {
    const u = await upgrade([OLD], GONE);

    const out = await u.apply({});

    expect(u.untracked(out)).toEqual([u.rows[OLD]]);
  });
});

describe('classifyApplyAction and the keep choice', () => {
  const selections = (over: Record<string, ReadonlySet<string>> = {}): ApplySelections =>
    ({
      selectedUpdates: new Set(),
      selectedNew: new Set(),
      selectedReinstate: new Set(),
      selectedObsoleteRemovals: new Set(),
      selectedRtkHookStrips: new Set(),
      conflictChoices: new Map(),
      ...over,
    }) as unknown as ApplySelections;
  const picks = (e: UpgradePlanEntry) => new Set([e.entryId]);
  const classify = (e: UpgradePlanEntry, over: Record<string, ReadonlySet<string>>) =>
    classifyApplyAction(e, [e], selections(over));

  it('untracks an obsolete Haive file that was picked to be kept', () => {
    const e = obsolete(OLD, { liveArtifactId: 'live-1' });
    expect(classify(e, { [KEEP_FIELD]: picks(e) })).toBe('untrack');
  });

  it('prefers a removal to a keep, and a hook strip to a keep', () => {
    const e = obsolete(OLD, { liveArtifactId: 'live-1' });
    expect(classify(e, { [KEEP_FIELD]: picks(e), selectedObsoleteRemovals: picks(e) })).toBe(
      'delete',
    );
    const settings = obsolete('.claude/settings.json', {
      templateId: 'rtk.claude-settings',
      templateKind: 'rtk-config',
      liveArtifactId: 'live-2',
    });
    expect(
      classify(settings, { [KEEP_FIELD]: picks(settings), selectedRtkHookStrips: picks(settings) }),
    ).toBe('strip');
  });

  it('prefers a keep to the default for a bundle item that is gone, and leaves an unpicked entry', () => {
    const custom = obsolete(OLD, {
      templateId: 'custom.bundle-1.item-1',
      liveArtifactId: 'live-3',
    });
    expect(classify(custom, { [KEEP_FIELD]: picks(custom) })).toBe('untrack');
    const plain = obsolete(OLDER, { liveArtifactId: 'live-4' });
    expect(classify(plain, {})).toBe('skip');
    expect(classify(plain, { [KEEP_FIELD]: new Set() })).toBe('skip');
  });

  it('has no row to untrack for an entry no row records', () => {
    const e = obsolete(OLD, { liveArtifactId: null });
    expect(classify(e, { [KEEP_FIELD]: picks(e) })).toBe('skip');
  });
});
