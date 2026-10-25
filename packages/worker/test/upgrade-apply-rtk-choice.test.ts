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
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { buildRtkAwarenessBlock } from '../src/step-engine/steps/onboarding/_rtk-templates.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { RECORD_WRITE_TABLES, recordWritten } from './support/upgrade-apply-record.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const ONBOARDING = '00000000-0000-4000-8000-0000000000c2';

const AGENT = '.claude/agents/adopted.md';
const OLD = 'OLD RENDER\n';
const NEW = 'NEW RENDER\n';
const AGENTS = `# Project\n\nOur notes.\n${buildRtkAwarenessBlock()}`;
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** An RTK-off plan that adopts one agent file, over a repository whose AGENTS.md holds an RTK block. */
async function setup(
  rtkFollowsLive: boolean | undefined,
  repo?: { rtkEnabled: boolean; rtkChoiceMadeAt: Date | null },
) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-rtk-choice-'));
  dirs.push(root);
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  await writeFile(join(root, AGENT), NEW, 'utf8');
  await writeFile(join(root, 'AGENTS.md'), AGENTS, 'utf8');
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    ...RECORD_WRITE_TABLES,
  });
  if (repo) {
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'acme',
      source: 'git_https',
      ...repo,
    });
  }
  const agentRow = fake.insert(schema.onboardingArtifacts, {
    userId: USER,
    repositoryId: REPO,
    taskId: ONBOARDING,
    diskPath: AGENT,
    templateId: 'agent.adopted',
    templateKind: 'agent',
    templateSchemaVersion: 1,
    templateContentHash: hashOf(OLD),
    writtenHash: hashOf(OLD),
    writtenContent: OLD,
    lastObservedDiskHash: hashOf(OLD),
    formValuesSnapshot: { from: 'onboarding' },
    sourceStepId: '12-post-onboarding',
    source: 'onboarding',
  }).id as string;
  const entry: UpgradePlanEntry = {
    entryId: `e:${AGENT}`,
    bucket: 'adopt',
    templateId: 'agent.adopted',
    templateKind: 'agent',
    diskPath: AGENT,
    liveArtifactId: agentRow,
    currentContent: NEW,
    newContent: NEW,
    baselineContent: null,
    currentHash: hashOf(NEW),
    baselineWrittenHash: hashOf(OLD),
    newContentHash: hashOf(NEW),
    baselineTemplateContentHash: hashOf(OLD),
    currentTemplateContentHash: hashOf(NEW),
    templateSchemaVersion: 1,
    delta: null,
  };
  const plan = {
    repositoryId: REPO,
    ranBackfill: false,
    entries: [entry],
    counts: {
      unchanged: 0,
      clean_update: 0,
      adopt: 1,
      conflict: 0,
      new_artifact: 0,
      user_deleted: 0,
      obsolete: 0,
      foreign: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: { ...REFERENCE_CONTEXT, rtkEnabled: false } as unknown as Record<
      string,
      unknown
    >,
    rtkFollowsLive,
    backfilledRows: 0,
  } as UpgradePlanOutput;
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
        formValues: {},
        iteration: 0,
        previousIterations: [],
      }),
    );
  const written = () => fake.rows(schema.onboardingArtifacts).filter((r) => r.taskId === TASK);
  return { root, apply, written };
}

describe('02 over a context that recorded no RTK choice', () => {
  it('takes no RTK block out, and records no choice in the rows it writes', async () => {
    const s = await setup(false);
    const out = await s.apply();

    const rows = s.written();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.formValuesSnapshot).not.toHaveProperty('rtkEnabled');
    }
    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toBe(AGENTS);
    expect(out.rtkBlockStrips ?? []).toEqual([]);
  });
});

describe('02 over a context that recorded RTK off', () => {
  it('takes the RTK block out, and keeps the choice in the rows it writes', async () => {
    const s = await setup(true);
    const out = await s.apply();

    expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toBe('# Project\n\nOur notes.\n');
    expect(out.rtkBlockStrips?.map((x) => x.file)).toContain('AGENTS.md');
    const rows = s.written();
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.formValuesSnapshot).toMatchObject({ rtkEnabled: false });
    }
  });
});

describe('02 after a person switched RTK since the plan', () => {
  const STAMP = new Date(1000);
  const switched = 'RTK was switched off after this upgrade was planned';

  it.each([false, undefined])(
    'refuses a plan that did not follow the switch (rtkFollowsLive %s)',
    async (follows) => {
      const s = await setup(follows, { rtkEnabled: false, rtkChoiceMadeAt: STAMP });

      await expect(s.apply()).rejects.toThrow(switched);

      expect(s.written()).toEqual([]);
      expect(await readFile(join(s.root, 'AGENTS.md'), 'utf8')).toBe(AGENTS);
      expect(await readFile(join(s.root, AGENT), 'utf8')).toBe(NEW);
    },
  );

  it('applies a plan over a repository nobody switched', async () => {
    const s = await setup(false, { rtkEnabled: false, rtkChoiceMadeAt: null });
    await s.apply();
    expect(s.written().length).toBeGreaterThan(0);
  });

  it('applies a followed plan whose value still holds', async () => {
    const s = await setup(true, { rtkEnabled: false, rtkChoiceMadeAt: STAMP });
    await s.apply();
    expect(s.written().length).toBeGreaterThan(0);
  });

  it('refuses a followed plan whose value changed', async () => {
    const s = await setup(true, { rtkEnabled: true, rtkChoiceMadeAt: STAMP });
    await expect(s.apply()).rejects.toThrow('RTK was switched on after this upgrade was planned');
    expect(s.written()).toEqual([]);
  });
});
