import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const AGENT = '.claude/agents/adopted.md';
const OLD = 'OLD RENDER\n';
const NEW = 'NEW RENDER\n';
const OLD_REGION = `${CLI_RULES_START}\nOLD RULES\n${CLI_RULES_END}`;
const NEW_REGION = `${CLI_RULES_START}\nNEW RULES\n${CLI_RULES_END}`;
const hashOf = (text: string) => sha256Hex(normalizeContent(text));

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A repository whose rows record OLD while its files already hold NEW, as after pulling an
 *  upgrade another install committed, and the plan that reads both as `adopt`. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'upgrade-apply-adopt-'));
  dirs.push(root);
  await mkdir(join(root, '.claude', 'agents'), { recursive: true });
  await writeFile(join(root, AGENT), NEW, 'utf8');
  await writeFile(join(root, 'AGENTS.md'), `# Notes\n\n${NEW_REGION}\n`, 'utf8');
  const fake = createFakeDb({
    onboardingArtifacts: schema.onboardingArtifacts,
    repositories: schema.repositories,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
  });
  const live = (diskPath: string, templateId: string, templateKind: string, content: string) =>
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: ONBOARDING,
      diskPath,
      templateId,
      templateKind,
      templateSchemaVersion: 1,
      templateContentHash: hashOf(content),
      writtenHash: hashOf(content),
      writtenContent: content,
      lastObservedDiskHash: hashOf(content),
      formValuesSnapshot: { from: 'onboarding' },
      sourceStepId: '12-post-onboarding',
      source: 'onboarding',
    }).id as string;
  const agentRow = live(AGENT, 'agent.adopted', 'agent', OLD);
  const rulesRow = live('AGENTS.md', 'cli-rules', CLI_RULES_TEMPLATE_KIND, OLD_REGION);
  const adopt = (
    diskPath: string,
    templateId: string,
    templateKind: string,
    liveArtifactId: string,
    before: string,
    after: string,
  ): UpgradePlanEntry => ({
    entryId: `e:${diskPath}`,
    bucket: 'adopt',
    templateId,
    templateKind,
    diskPath,
    liveArtifactId,
    currentContent: after,
    newContent: after,
    baselineContent: null,
    currentHash: hashOf(after),
    baselineWrittenHash: hashOf(before),
    newContentHash: hashOf(after),
    baselineTemplateContentHash: hashOf(before),
    currentTemplateContentHash: hashOf(after),
    templateSchemaVersion: 1,
    delta: null,
  });
  const plan = {
    repositoryId: REPO,
    ranBackfill: false,
    entries: [
      adopt(AGENT, 'agent.adopted', 'agent', agentRow, OLD, NEW),
      adopt('AGENTS.md', 'cli-rules', CLI_RULES_TEMPLATE_KIND, rulesRow, OLD_REGION, NEW_REGION),
    ],
    counts: {
      unchanged: 0,
      clean_update: 0,
      adopt: 2,
      conflict: 0,
      new_artifact: 0,
      user_deleted: 0,
      obsolete: 0,
    },
    installedTemplateSetHash: null,
    currentTemplateSetHash: 'set',
    renderCtxSnapshot: REFERENCE_CONTEXT as unknown as Record<string, unknown>,
    backfilledRows: 0,
  } as UpgradePlanOutput;
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
      formValues: {},
      iteration: 0,
      previousIterations: [],
    });
  const rowsAt = (diskPath: string) =>
    fake.rows(schema.onboardingArtifacts).filter((r) => r.diskPath === diskPath);
  return { root, plan, apply, rowsAt, agentRow, rulesRow };
}

describe('an upgrade over files that already hold the new render', () => {
  it('records them as current without writing them, outside what a rollback restores', async () => {
    const s = await setup();
    const out = await s.apply();

    expect(out.adoptedCount).toBe(2);
    expect(out.appliedCount).toBe(0);
    for (const [path, rowId, render] of [
      [AGENT, s.agentRow, NEW],
      ['AGENTS.md', s.rulesRow, NEW_REGION],
    ] as const) {
      const rows = s.rowsAt(path);
      expect(rows.find((r) => r.id === rowId)?.supersededAt).toBeInstanceOf(Date);
      const current = rows.filter((r) => r.supersededAt === null);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({
        source: 'backfill',
        templateContentHash: hashOf(render),
        writtenHash: hashOf(render),
        lastObservedDiskHash: hashOf(render),
        userModified: false,
      });
      expect(normalizeContent(String(current[0]!.writtenContent))).toBe(normalizeContent(render));
      expect(out.writtenPaths).not.toContain(path);
      expect(out.createdPaths?.map((c) => c.diskPath)).not.toContain(path);
      expect(out.retiredRowIds).not.toContain(rowId);
    }
  });

  it('records nothing more when the apply runs again', async () => {
    const s = await setup();
    await s.apply();
    const again = await s.apply();

    expect(again.adoptedCount).toBe(0);
    expect(s.rowsAt(AGENT)).toHaveLength(2);
    expect(s.rowsAt('AGENTS.md')).toHaveLength(2);
  });

  it('leaves a file changed after the plan to the next upgrade', async () => {
    const s = await setup();
    await writeFile(join(s.root, AGENT), 'EDITED SINCE\n', 'utf8');
    const out = await s.apply();

    expect(out.adoptedCount).toBe(1);
    expect(s.rowsAt(AGENT)).toEqual([
      expect.objectContaining({ id: s.agentRow, supersededAt: null }),
    ]);
    expect(out.warnings.join('\n')).toContain(AGENT);
  });
});
