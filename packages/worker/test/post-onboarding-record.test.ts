import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const RECORD_FORMAT = '.haive-data/state/format.json';
const RECORD_RENDER = '.haive-data/state/project/render.json';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** What step 07 detected: the render context it leaves for 12, and the providers whose rules it wrote. */
const DETECT = {
  ...(REFERENCE_CONTEXT as unknown as Record<string, unknown>),
  framework: 'drupal',
  acceptedAgentIds: ['code-reviewer'],
  language: 'php',
  projectName: 'acme',
  cliProviders: [],
  plannedAgents: [],
  existingFiles: [],
  mcpSettingsJson: '{}',
};

/** Step 12 on a repository onboarded with the DETECT above, whose artifact recording is made to fail
 *  after the render context exists: either the install manifest cannot be written (a link stands where
 *  it goes), or the database refuses the artifact rows. */
async function setup(
  failure: 'none' | 'manifest-link' | 'artifact-rows',
  detect: Record<string, unknown> = DETECT,
) {
  const root = await mkdtemp(join(tmpdir(), 'post-onboarding-record-'));
  const outside = await mkdtemp(join(tmpdir(), 'post-onboarding-record-out-'));
  dirs.push(root, outside);
  if (failure === 'manifest-link') {
    await mkdir(join(root, '.haive'), { recursive: true });
    await symlink(join(outside, 'elsewhere.json'), join(root, '.haive', 'install.json'));
  }
  // No plan tables: the plan mirror warns and the record does not depend on it.
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    projectStateSync: schema.projectStateSync,
  });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'acme', source: 'upload' });
  fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: REPO, type: 'onboarding' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '07-generate-files',
    stepIndex: 7,
    round: 0,
    title: 'Generate files',
    status: 'done',
    detectOutput: detect,
  });
  if (failure === 'artifact-rows') {
    fake.hooks.beforeInsert = (table) => {
      if (table === schema.onboardingArtifacts) throw new Error('database refused');
    };
  }
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  const apply = () =>
    postOnboardingStep.apply(ctx, {
      detected: {
        hasGit: false,
        currentBranch: null,
        hasOrigin: false,
        originUrl: null,
        boundCredentialId: null,
        credentials: [],
      },
      formValues: { commit: false },
    } as never);
  return {
    root,
    apply,
    column: () => fake.rows(schema.repositories)[0]!.renderContext ?? null,
    syncRows: () => fake.rows(schema.projectStateSync),
  };
}

describe('12 writes the project state record whatever the artifact recording did', () => {
  it('writes it, and the artifact rows, when nothing fails', async () => {
    const s = await setup('none');

    const out = await s.apply();

    expect(out.warnings.filter((w) => w.includes('onboarding-artifacts'))).toEqual([]);
    expect(out.artifactRowsWritten).toBeGreaterThan(0);
    expect(out.installManifestWritten).toBe(true);
    expect(existsSync(join(s.root, RECORD_FORMAT))).toBe(true);
    expect(existsSync(join(s.root, RECORD_RENDER))).toBe(true);
    expect(s.column()).toMatchObject({
      framework: 'drupal',
      acceptedAgentIds: DETECT.acceptedAgentIds,
      rtkChoiceRecorded: true,
    });
    expect(s.syncRows()).toHaveLength(1);
  });

  it.each([
    [
      'a link stands where the install manifest goes',
      'manifest-link',
      'a symlink in the path: .haive/install.json',
    ],
    ['the database refuses the artifact rows', 'artifact-rows', 'database refused'],
  ] as const)('writes it when %s', async (_what, failure, reason) => {
    const s = await setup(failure);

    const out = await s.apply();

    // The recording failed, after the context it derives from 07's output existed.
    expect(out.warnings).toContain(`onboarding-artifacts recording failed: ${reason}`);
    expect(out.installManifestWritten).toBe(false);
    // Soft, so that a run which skipped the record shows everything it left out.
    for (const rel of [RECORD_FORMAT, RECORD_RENDER]) {
      expect.soft(existsSync(join(s.root, rel)), rel).toBe(true);
    }
    expect.soft(s.column()).toMatchObject({
      framework: 'drupal',
      acceptedAgentIds: DETECT.acceptedAgentIds,
      rtkChoiceRecorded: true,
    });
    expect.soft(s.syncRows()).toHaveLength(1);
    expect.soft(out.warnings.filter((w) => w.includes('project state record'))).toEqual([]);
  });

  it('records no RTK choice for a 07 output from before RTK shipped', async () => {
    const preRtk: Record<string, unknown> = { ...DETECT };
    delete preRtk.rtkEnabled;
    const s = await setup('none', preRtk);

    await s.apply();

    expect(s.column()).toMatchObject({ rtkEnabled: false, rtkChoiceRecorded: false });
  });
});
