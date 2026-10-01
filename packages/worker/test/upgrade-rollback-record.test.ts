import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const UPGRADE_TASK = '00000000-0000-4000-8000-0000000000c2';
const ONBOARDING_TASK = '00000000-0000-4000-8000-0000000000c3';
const CREATED = '.claude/agents/new.md';
const KEPT = '.claude/agents/old.md';
const RECORD_RENDER = '.haive-data/state/project/render.json';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** What a render context holds, with the fields a test varies. */
const context = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  projectInfo: { name: 'acme' },
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
  lspLanguages: [],
  rtkEnabled: false,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  ...over,
});

/** The context before the upgrade and the one it renders from, which differ in every field a
 *  record or the column holds. */
const BEFORE = context();
const UPGRADE = context({
  framework: 'laravel',
  acceptedAgentIds: ['security-auditor'],
  rtkEnabled: true,
});

/** An upgrade that only created a file, rolled back. The repository holds the upgrade's context, the
 *  upgrade's own row (the newest, still live until the rollback retires it) and one older row. */
async function rollback(older: Record<string, unknown> | null) {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-rollback-record-'));
  dirs.push(root);
  await mkdir(join(root, '.claude/agents'), { recursive: true });
  await writeFile(join(root, CREATED), 'HAIVE\n', 'utf8');
  const hash = sha256Hex(normalizeContent('HAIVE\n'));

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
    renderContext: { ...UPGRADE, rtkChoiceRecorded: true },
  });
  // The upgrade's plan found the RTK choice recorded: the choice a rollback records is the plan's.
  fake.insert(schema.taskSteps, {
    taskId: UPGRADE_TASK,
    stepId: '01-upgrade-plan',
    stepIndex: 1,
    round: 0,
    title: 'Plan upgrade',
    status: 'done',
    output: { repositoryId: REPO, entries: [], rtkFollowsLive: true },
  });
  const row = (over: Record<string, unknown>) =>
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: hash,
      writtenHash: hash,
      ...over,
    });
  const upgradeRow = row({
    taskId: UPGRADE_TASK,
    diskPath: CREATED,
    templateId: 'agent.new',
    source: 'upgrade',
    formValuesSnapshot: UPGRADE,
    generatedAt: new Date('2026-02-01T00:00:00Z'),
  });
  row({
    taskId: ONBOARDING_TASK,
    diskPath: KEPT,
    templateId: 'agent.old',
    source: 'onboarding',
    formValuesSnapshot: older,
    generatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const detected = {
    repositoryId: REPO,
    rolledBackFromTaskId: UPGRADE_TASK,
    targets: [],
    newArtifactsToUndo: [
      {
        diskPath: CREATED,
        templateKind: 'agent',
        upgradeArtifactId: upgradeRow.id as string,
        writtenHash: hash,
      },
    ],
    warnings: [],
  };
  const out = await upgradeRollbackStep.apply(ctx, { detected } as never);
  return {
    root,
    out,
    column: fake.rows(schema.repositories)[0]!.renderContext,
    sync: fake.rows(schema.projectStateSync),
  };
}

describe('the context a rollback records when the upgrade only created files', () => {
  it('is the one the rows still live carry, never the upgrade’s own, with its RTK choice', async () => {
    const { root, out, column, sync } = await rollback(BEFORE);

    expect(out.warnings).toEqual([]);
    expect(column).toEqual({ ...BEFORE, rtkChoiceRecorded: true });
    const record = JSON.parse(await readFile(join(root, RECORD_RENDER), 'utf8')) as {
      framework: string;
      acceptedAgentIds: string[];
    };
    expect([record.framework, record.acceptedAgentIds]).toEqual(['drupal', ['code-reviewer']]);
    expect(sync).toHaveLength(1);
    expect(sync[0]!.repositoryId).toBe(REPO);
    expect(sync[0]!.lastError).toBeNull();
    expect(sync[0]!.baseSnapshot).toMatchObject({
      render: { framework: 'drupal', acceptedAgentIds: ['code-reviewer'] },
    });
  });

  it('records the choice as not recorded when the context holds none', async () => {
    const { rtkEnabled: _chosen, ...older } = BEFORE;

    const { column } = await rollback(older);

    expect(column).toEqual({ ...older, rtkChoiceRecorded: false });
  });

  it('writes nothing when no row still live carries a context', async () => {
    const { root, out, column, sync } = await rollback(null);

    expect(out.warnings).toEqual([]);
    expect(column).toEqual({ ...UPGRADE, rtkChoiceRecorded: true });
    expect(sync).toEqual([]);
    await expect(readFile(join(root, RECORD_RENDER), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
