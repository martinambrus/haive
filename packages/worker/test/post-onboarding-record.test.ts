import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
 *  after the render context exists: the database refuses the artifact rows. */
async function setup(failure: 'none' | 'artifact-rows', detect: Record<string, unknown> = DETECT) {
  const root = await mkdtemp(join(tmpdir(), 'post-onboarding-record-'));
  dirs.push(root);
  // No plan tables: the plan mirror warns and the record does not depend on it.
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    users: schema.users,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
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
  const applyCommit = () =>
    postOnboardingStep.apply(ctx, {
      detected: { hasGit: true, currentBranch: 'main', hasOrigin: false, credentials: [] },
      formValues: { commit: true, commitMessage: 'onboard' },
    } as never);
  return {
    root,
    fake,
    apply,
    applyCommit,
    liveRows: () => fake.rows(schema.onboardingArtifacts).filter((r) => r.supersededAt == null),
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
    expect(existsSync(join(s.root, RECORD_FORMAT))).toBe(true);
    expect(existsSync(join(s.root, RECORD_RENDER))).toBe(true);
    expect(s.column()).toMatchObject({
      framework: 'drupal',
      acceptedAgentIds: DETECT.acceptedAgentIds,
      rtkChoiceRecorded: true,
    });
    expect(s.syncRows()).toHaveLength(1);
  });

  it('writes it when the database refuses the artifact rows', async () => {
    const s = await setup('artifact-rows');

    const out = await s.apply();

    // The recording failed, after the context it derives from 07's output existed.
    expect(out.warnings).toContain('onboarding-artifacts recording failed: database refused');
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

describe('12 commits the artifact claims it wrote into the record', () => {
  const git = promisify(execFile);

  it('holds a claim file per live artifact row in its commit', async () => {
    const s = await setup('none');
    await git('git', ['-C', s.root, 'init', '-q', '-b', 'main']);
    await git('git', ['-C', s.root, 'config', 'user.email', 't@example.com']);
    await git('git', ['-C', s.root, 'config', 'user.name', 'T']);
    await git('git', ['-C', s.root, 'config', 'gc.auto', '0']);
    await writeFile(join(s.root, 'README.md'), 'hi\n');
    await git('git', ['-C', s.root, 'add', 'README.md']);
    await git('git', ['-C', s.root, 'commit', '-qm', 'seed']);

    const out = await s.applyCommit();

    expect(out.commitPerformed).toBe(true);
    const tree = (await git('git', ['-C', s.root, 'ls-tree', '-r', '--name-only', 'HEAD'])).stdout
      .split('\n')
      .filter(Boolean);
    const claims = tree.filter((p) => /^\.haive-data\/state\/artifacts\/.+\.json$/.test(p));
    expect(s.liveRows().length).toBeGreaterThan(0);
    expect(claims).toHaveLength(s.liveRows().length);
    expect(tree).toContain(RECORD_RENDER);
  });
});

describe('12 retires .haive/install.json', () => {
  const git = promisify(execFile);
  const HAIVE_SHAPED = JSON.stringify({
    schemaVersion: 1,
    haiveVersion: '0.1.0',
    templateSetHash: 'abc',
    templates: [],
  });

  const gitOut = async (root: string, ...args: string[]): Promise<string> =>
    (await git('git', ['-C', root, ...args])).stdout;

  /** A repository with one commit, and `.haive/install.json` tracked in it when `installJson` is given. */
  async function seededSetup(installJson?: string) {
    const s = await setup('none');
    await git('git', ['-C', s.root, 'init', '-q', '-b', 'main']);
    await git('git', ['-C', s.root, 'config', 'user.email', 't@example.com']);
    await git('git', ['-C', s.root, 'config', 'user.name', 'T']);
    await git('git', ['-C', s.root, 'config', 'gc.auto', '0']);
    await writeFile(join(s.root, 'README.md'), 'hi\n');
    await git('git', ['-C', s.root, 'add', 'README.md']);
    if (installJson !== undefined) {
      await mkdir(join(s.root, '.haive'), { recursive: true });
      await writeFile(join(s.root, '.haive', 'install.json'), installJson);
      await git('git', ['-C', s.root, 'add', '-f', '.haive/install.json']);
    }
    await git('git', ['-C', s.root, 'commit', '-qm', 'seed']);
    return s;
  }

  const trackedFiles = async (root: string): Promise<string[]> =>
    (await gitOut(root, 'ls-tree', '-r', '--name-only', 'HEAD')).split('\n').filter(Boolean);

  it('leaves the checkout clean after two identical runs', async () => {
    const s = await seededSetup();

    const first = await s.applyCommit();
    expect(first.commitPerformed).toBe(true);
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
    const head = await gitOut(s.root, 'rev-parse', 'HEAD');

    const second = await s.applyCommit();

    expect(second.commitPerformed).toBe(false);
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
    expect(await gitOut(s.root, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(false);
  });

  it('drops a tracked Haive-shaped file from the commit and the disk', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    expect(await trackedFiles(s.root)).toContain('.haive/install.json');

    const out = await s.applyCommit();

    expect(out.commitPerformed).toBe(true);
    expect(await trackedFiles(s.root)).not.toContain('.haive/install.json');
    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(false);
    expect(await gitOut(s.root, 'status', '--porcelain')).toBe('');
  });

  it('stages the deletion on a retry that finds the file already gone', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    await rm(join(s.root, '.haive', 'install.json'));

    await s.applyCommit();

    expect(await trackedFiles(s.root)).not.toContain('.haive/install.json');
  });

  it("keeps a file that is not Haive's, and says so", async () => {
    const s = await seededSetup('{"keep":true}');

    const out = await s.applyCommit();

    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(true);
    expect(await trackedFiles(s.root)).toContain('.haive/install.json');
    expect(out.warnings.some((w) => w.startsWith('.haive/install.json was left in place'))).toBe(
      true,
    );
  });

  it('keeps a link standing there and still writes the record', async () => {
    const s = await seededSetup();
    const outside = await mkdtemp(join(tmpdir(), 'post-onboarding-record-out-'));
    dirs.push(outside);
    await writeFile(join(outside, 'elsewhere.json'), HAIVE_SHAPED);
    await mkdir(join(s.root, '.haive'), { recursive: true });
    await symlink(join(outside, 'elsewhere.json'), join(s.root, '.haive', 'install.json'));

    const out = await s.apply();

    expect(out.warnings.some((w) => w.startsWith('.haive/install.json was left in place'))).toBe(
      true,
    );
    expect(existsSync(join(outside, 'elsewhere.json'))).toBe(true);
    expect(existsSync(join(s.root, RECORD_RENDER))).toBe(true);
  });

  it('leaves the file alone when the record write failed', async () => {
    const s = await seededSetup(HAIVE_SHAPED);
    let refused = false;
    s.fake.hooks.beforeLock = (key) => {
      if (key.includes('project-state') && !refused) {
        refused = true;
        throw new Error('database refused');
      }
    };

    const out = await s.apply();

    expect(out.warnings).toContain('project state record write failed: database refused');
    expect(existsSync(join(s.root, '.haive', 'install.json'))).toBe(true);
  });
});
