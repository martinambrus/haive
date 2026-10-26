import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { normalizeContent, sha256Hex } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { upgradeRollbackStep } from '../src/step-engine/steps/onboarding-upgrade/04-upgrade-rollback.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import { recordWritten, ROLLBACK_RECORD_WRITE_TABLES } from './support/upgrade-apply-record.js';

// design-227.md Decision 3: a rollback writes the set its snapshot renders and keeps none of the ids it
// restored, so a restored claim its snapshot does not render is outside the set, where upgrade-status
// reports it while 02 could remove it.

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const UPGRADE_TASK = '00000000-0000-4000-8000-0000000000c2';
const PRIOR_ROW = '00000000-0000-4000-8000-0000000000d1';
const REMOVED = '.claude/agents/security-auditor.md';
const BUNDLE = '00000000-0000-4000-8000-0000000000e1';
const ITEM = '00000000-0000-4000-8000-0000000000e2';
const AGENT = {
  id: 'billing',
  title: 'Billing',
  description: 'Billing agent',
  color: 'blue',
  field: 'billing',
  tools: [],
  coreMission: 'Bill',
  responsibilities: [],
  whenInvoked: [],
  executionSteps: [],
  outputFormat: '',
  qualityCriteria: [],
  antiPatterns: [],
};
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** The reference context accepting only code-reviewer on its one agents directory. */
const SNAPSHOT = { ...REFERENCE_CONTEXT, acceptedAgentIds: ['code-reviewer'] } as unknown as Record<
  string,
  unknown
>;

describe('R1: a rollback and the applicable set', () => {
  it('writes the set its snapshot renders with the bundle items and cli-rules, without the agent whose removal it undid', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'upgrade-rollback-set-'));
    dirs.push(repoPath);
    const fake = createFakeDb({
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
      cliProviders: schema.cliProviders,
      customBundles: schema.customBundles,
      customBundleItems: schema.customBundleItems,
      ...ROLLBACK_RECORD_WRITE_TABLES,
    });
    fake.insert(schema.repositories, {
      id: REPO,
      userId: USER,
      name: 'acme',
      source: 'blank',
      renderContext: null,
      applicableTemplateIds: null,
    });
    fake.insert(schema.cliProviders, {
      userId: USER,
      name: 'claude-code',
      label: 'Claude Code',
      enabled: true,
      rulesContent: 'Always be kind.',
    });
    fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: USER,
      repositoryId: REPO,
      name: 'acme-kit',
      sourceType: 'zip',
      storageRoot: '/bundles/acme-kit',
    });
    fake.insert(schema.customBundleItems, {
      id: ITEM,
      bundleId: BUNDLE,
      kind: 'agent',
      sourceFormat: 'claude-md',
      sourcePath: 'agents/billing.md',
      normalizedSpec: AGENT,
      contentHash: 'c'.repeat(64),
    });
    const detected = {
      repositoryId: REPO,
      rolledBackFromTaskId: UPGRADE_TASK,
      targets: [
        {
          diskPath: REMOVED,
          templateId: 'agent.security-auditor',
          templateKind: 'agent',
          templateSchemaVersion: 1,
          priorArtifactId: PRIOR_ROW,
          upgradeArtifactId: null,
          removed: true,
          priorTemplateContentHash: hashOf('SA\n'),
          priorWrittenHash: hashOf('SA\n'),
          priorWrittenContent: 'SA\n',
          priorFormValuesSnapshot: SNAPSHOT,
        },
      ],
      newArtifactsToUndo: [],
      warnings: [],
    };
    const noop = () => undefined;
    fake.insert(schema.tasks, {
      id: TASK,
      userId: USER,
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'running',
      title: 'rollback',
    });
    const ctx = {
      db: fake.db,
      repoPath,
      taskId: TASK,
      userId: USER,
      logger: { info: noop, warn: noop, error: noop, debug: noop },
    } as unknown as StepContext;

    await recordWritten(upgradeRollbackStep.apply(ctx, { detected } as never));

    expect(await readFile(join(repoPath, REMOVED), 'utf8')).toBe('SA\n');
    const live = fake
      .rows(schema.onboardingArtifacts)
      .filter((r) => r.diskPath === REMOVED && r.supersededAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.writtenHash).toBe(hashOf('SA\n'));
    expect(fake.rows(schema.repositories)[0]!.applicableTemplateIds).toEqual([
      'agent.code-reviewer',
      'agents-index',
      'cli-rules',
      `custom.${BUNDLE}.${ITEM}`,
      'workflow-config',
    ]);
  });
});
