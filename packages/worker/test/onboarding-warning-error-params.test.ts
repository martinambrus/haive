import { DrizzleQueryError } from 'drizzle-orm/errors';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import { logger } from '@haive/shared/logger';

const h = vi.hoisted(() => ({ site: '', error: undefined as unknown, hits: 0 }));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<object>()),
  writePlanMirror: async () => {
    if (h.site === 'post-plan') {
      h.hits++;
      throw h.error;
    }
  },
}));
// Commit plumbing is outside the warning contract; retain the actual apply and completion log.
vi.mock('../src/step-engine/steps/onboarding/_stage-paths.js', async (original) => ({
  ...(await original<object>()),
  collectOnboardingStagePaths: async () => ({ add: ['fixture.txt'], remove: [] }),
  commitRecorded: async () => ['fixture.txt'],
}));
vi.mock('../src/repo/git-workspace.js', async (original) => ({
  ...(await original<object>()),
  requireUsableGit: async () => true,
}));
vi.mock('../src/repo/git-exec.js', async (original) => ({
  ...(await original<object>()),
  gitExec: async () => ({ stdout: 'fixture-head', stderr: '' }),
}));
vi.mock('../src/secrets/user-git-identity.js', async (original) => ({
  ...(await original<object>()),
  resolveGitEnv: async () => ({}),
}));
vi.mock('../src/step-engine/steps/onboarding/_rules-files.js', async (original) => ({
  ...(await original<object>()),
  dropIgnoredRulesFiles: async (_root: string, paths: string[]) => ({ keep: paths, warnings: [] }),
}));

import type { StepContext } from '../src/step-engine/step-definition.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import {
  upgradeApplyStep,
  HAIVE_FILE_RETIRED_EVENT,
} from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import type {
  UpgradePlanOutput,
  UpgradePlanEntry,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { ProjectStateWriteError } from '../src/project-state/write.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const PRIOR = '00000000-0000-4000-8000-0000000000c2';
const INSTALL = '.haive/install.json';
const secret = 'ONBOARDING_BOUND_SECRET_426';
const ordinary = 'ordinary warning\n  exact whitespace';
const query = 'insert into fixture (value) values ($1)';
const lines: string[] = [];
const dirs: string[] = [];
beforeEach(() => {
  h.hits = 0;
  lines.length = 0;
  const key = Object.getOwnPropertySymbols(logger).find(
    (key) => key.description === 'pino.stream',
  )!;
  const stream = (logger as unknown as Record<symbol, { write: (line: string) => void }>)[key]!;
  vi.spyOn(stream, 'write').mockImplementation((line) => {
    lines.push(line);
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const cases = [
  ['post-plan', (m: string) => `haive-data mirror: plan mirror failed (${m})`],
  ['post-artifacts', (m: string) => `onboarding-artifacts recording failed: ${m}`],
  ['post-record', (m: string) => `project state record write failed: ${m}`],
  ['post-lookup', (m: string) => `haive-data mirror write failed: ${m}`],
  ['upgrade-removal', (m: string) => `failed to delete obsolete.md: ${m}`],
  [
    'upgrade-void',
    (m: string) => `${INSTALL}: the earlier record of its removal could not be voided: ${m}`,
  ],
  ['upgrade-record', (m: string) => `project state record write failed: ${m}`],
  ['upgrade-lookup', (m: string) => `did not list the files this task removed earlier: ${m}`],
  ['rollback-record', (m: string) => `project state record write failed: ${m}`],
] as const;

async function setup(site: string) {
  const root = await mkdtemp(join(tmpdir(), 'haive-onboarding-warning-'));
  dirs.push(root);
  await writeFile(join(root, 'fixture.txt'), 'fixture\n');
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    taskEvents: schema.taskEvents,
    repositories: schema.repositories,
    users: schema.users,
    cliProviders: schema.cliProviders,
    onboardingArtifacts: schema.onboardingArtifacts,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'fixture',
    source: 'blank',
    renderContext: { ...REFERENCE_CONTEXT, rtkChoiceRecorded: false },
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'onboarding',
    status: 'running',
    title: 'fixture',
  });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '07-generate-files',
    stepIndex: 7,
    round: 0,
    title: 'Generate',
    status: 'done',
    detectOutput: {
      ...REFERENCE_CONTEXT,
      framework: 'drupal',
      acceptedAgentIds: ['code-reviewer'],
      language: 'php',
      projectName: 'fixture',
      cliProviders: [],
      plannedAgents: [],
      existingFiles: [],
      mcpSettingsJson: '{}',
    },
  });
  // A rollback with no files to undo still restores this live snapshot through the real writer.
  fake.insert(schema.onboardingArtifacts, {
    userId: USER,
    repositoryId: REPO,
    taskId: PRIOR,
    diskPath: 'prior.md',
    templateId: 'agent.code-reviewer',
    templateKind: 'agent',
    templateSchemaVersion: 1,
    templateContentHash: 'a'.repeat(64),
    writtenHash: 'b'.repeat(64),
    source: 'onboarding',
    formValuesSnapshot: REFERENCE_CONTEXT,
  });
  if (site === 'upgrade-void') {
    await mkdir(join(root, '.haive'), { recursive: true });
    await writeFile(join(root, INSTALL), '{"person":true}');
    fake.insert(schema.taskEvents, {
      taskId: TASK,
      eventType: HAIVE_FILE_RETIRED_EVENT,
      payload: { path: INSTALL },
    });
    fake.hooks.beforeDelete = (table) => {
      if (table === schema.taskEvents) {
        h.hits++;
        throw h.error;
      }
    };
  }
  fake.hooks.beforeInsert = (table) => {
    if (
      (site === 'post-artifacts' || site === 'upgrade-removal') &&
      table === schema.onboardingArtifacts
    ) {
      h.hits++;
      throw h.error;
    }
    if (site.endsWith('-record') && table === schema.projectStateSync) {
      h.hits++;
      throw h.error;
    }
  };
  // Inject the exact outer lookup failures without replacing the real record transaction/clear.
  const db = fake.db as unknown as {
    select: (fields?: Record<string, unknown>) => { from: (table: unknown) => unknown };
  };
  const select = db.select.bind(db);
  let eventReads = 0;
  db.select = (fields) => {
    const builder = select(fields);
    const from = builder.from.bind(builder);
    builder.from = (table) => {
      if (
        site === 'post-lookup' &&
        fields &&
        'onboardingEnvironment' in fields &&
        Object.keys(fields).length === 3
      ) {
        h.hits++;
        throw h.error;
      }
      if (site === 'upgrade-lookup' && table === schema.taskEvents) {
        if (++eventReads === 1) throw new Error('fixture retirement lookup refused');
        h.hits++;
        throw h.error;
      }
      return from(table);
    };
    return builder;
  };
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    taskStepId: '00000000-0000-4000-8000-0000000000d1',
    logger: logger.child({ module: 'onboarding-warning-control' }),
    throwIfCancelled: () => {},
  } as unknown as StepContext;
  const hash = sha256Hex(normalizeContent('obsolete\n'));
  const entries: UpgradePlanEntry[] = [];
  if (site === 'upgrade-removal') {
    await writeFile(join(root, 'obsolete.md'), 'obsolete\n');
    entries.push({
      entryId: 'obsolete',
      bucket: 'obsolete',
      templateId: 'agent.old',
      diskPath: 'obsolete.md',
      templateKind: 'agent',
      liveArtifactId: null,
      currentContent: 'obsolete\n',
      currentHash: hash,
      baselineWrittenHash: hash,
      baselineTemplateContentHash: hash,
      baselineContent: 'obsolete\n',
      newContent: null,
      newContentHash: null,
      currentTemplateContentHash: null,
      templateSchemaVersion: 1,
      delta: null,
    });
  }
  const plan = {
    repositoryId: REPO,
    entries,
    renderCtxSnapshot: REFERENCE_CONTEXT,
    ranBackfill: false,
    backfilledRows: 0,
    counts: {},
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'fixture',
  } as unknown as UpgradePlanOutput;
  const apply = () =>
    site.startsWith('post-')
      ? postOnboardingStep.apply(ctx, {
          detected: { hasGit: true },
          formValues: { commit: true },
        } as never)
      : site.startsWith('upgrade-')
        ? upgradeApplyStep.apply(ctx, {
            detected: plan,
            formValues: { selectedObsoleteRemovals: ['obsolete'] },
          } as never)
        : upgradeRollbackStep.apply(ctx, {
            detected: {
              repositoryId: REPO,
              rolledBackFromTaskId: PRIOR,
              targets: [],
              newArtifactsToUndo: [],
              warnings: [],
            },
          } as never);
  return { fake, apply };
}

for (const [site, warning] of cases) {
  it.each([true, false])(
    `${site} keeps actual apply output and completion warnings safe (bound: %s)`,
    async (bound) => {
      h.site = site;
      h.error = bound
        ? new DrizzleQueryError(
            query,
            [secret],
            Object.assign(new Error(secret), { code: '23505' }),
          )
        : new TypeError(ordinary);
      const s = await setup(site);
      const out = await s.apply();
      expect(h.hits).toBe(1);
      expect.soft(out.warnings).toContain(warning(bound ? 'Database operation failed' : ordinary));
      const completion = lines
        .map((line) => JSON.parse(line))
        .find((line) => /(?:apply|rollback) complete$/.test(line.msg));
      expect(completion?.warnings).toEqual(out.warnings);
      expect(JSON.stringify([out, lines]).includes(secret)).toBe(false);
      if (site.endsWith('-record')) {
        expect(out.recordWrite).toBe('failed');
        expect(s.fake.rows(schema.repositories)[0]!.renderContext).toBeNull();
        const failure = lines
          .map((line) => JSON.parse(line))
          .find((line) => line.msg === 'project state record write failed');
        expect(failure?.err.type).toBe('ProjectStateWriteError');
        if (bound) expect(failure?.err).toMatchObject({ code: '23505', query });
      }
    },
  );
}

it.each(['post-record', 'upgrade-record', 'rollback-record'])(
  '%s still throws when the failed write cannot clear the column',
  async (site) => {
    h.site = site;
    h.error = new DrizzleQueryError(
      query,
      [secret],
      Object.assign(new Error(secret), { code: '23505' }),
    );
    const s = await setup(site);
    s.fake.hooks.beforeUpdate = (table) => {
      if (table === schema.repositories && h.hits > 0) throw new Error('column clear refused');
    };
    const err = await s.apply().catch((err: unknown) => err);
    expect(err).toBeInstanceOf(ProjectStateWriteError);
    expect(err).toMatchObject({ columnStale: true, cause: h.error });
    expect(s.fake.rows(schema.repositories)[0]!.renderContext).not.toBeNull();
    expect(
      lines
        .map((line) => JSON.parse(line))
        .some((line) => /(?:apply|rollback) complete$/.test(line.msg)),
    ).toBe(false);
    expect(JSON.stringify(lines).includes(secret)).toBe(false);
  },
);

it('post-plan scrubs server paths while preserving the mirror diagnosis', async () => {
  h.site = 'post-plan';
  h.error = new Error("EACCES: open '/srv/private/repo/.haive-data/plan.json'");
  const s = await setup(h.site);
  const out = await s.apply();
  expect(h.hits).toBe(1);
  expect(out.warnings).toContain("haive-data mirror: plan mirror failed (EACCES: open '[path]')");
});
