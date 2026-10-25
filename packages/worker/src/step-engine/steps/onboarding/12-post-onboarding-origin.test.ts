import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../../step-definition.js';
import { killGit, type KilledGit } from '../../../../test/support/kill-git.js';
import { recordWritten } from '../../../../test/support/upgrade-apply-record.js';
import { REFERENCE_CONTEXT } from '../../template-manifest.js';
import { postOnboardingStep } from './12-post-onboarding.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

const dirs: string[] = [];
let killed: KilledGit | null = null;
afterEach(async () => {
  await killed?.restore();
  killed = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

async function repo(origin: 'none' | 'unreadable' | 'good') {
  const root = await mkdtemp(join(tmpdir(), 'post-onboarding-origin-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'gc.auto', '0');
  if (origin !== 'none') git(root, 'remote', 'add', 'origin', 'https://example.com/x.git');
  // Makes `git remote get-url origin` exit 128 while rev-parse and status still work.
  if (origin === 'unreadable') git(root, 'config', '--add', 'remote.origin.fetch', ':::bad');
  return root;
}

function ctxFor(root: string) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    repositories: schema.repositories,
    repoCredentials: schema.repoCredentials,
    onboardingArtifacts: schema.onboardingArtifacts,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
    cliProviders: schema.cliProviders,
    users: schema.users,
    projectStateSync: schema.projectStateSync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.tasks, { id: TASK, userId: USER, repositoryId: null, type: 'onboarding' });
  const noop = () => undefined;
  const ctx = {
    db: fake.db,
    repoPath: root,
    taskId: TASK,
    userId: USER,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
  return ctx;
}

async function ctxForRecording(root: string) {
  const ctx = ctxFor(root);
  await ctx.db.insert(schema.repositories).values({
    id: REPO,
    userId: USER,
    name: 'acme',
    source: 'upload',
  });
  await ctx.db
    .update(schema.tasks)
    .set({ repositoryId: REPO, status: 'running' })
    .where(eq(schema.tasks.id, TASK));
  await ctx.db.insert(schema.taskSteps).values({
    taskId: TASK,
    stepId: '07-generate-files',
    stepIndex: 7,
    round: 0,
    title: 'Generate files',
    status: 'done',
    detectOutput: { ...REFERENCE_CONTEXT, cliProviders: [] },
  });
  return ctx;
}

const fieldIds = (fields: { id: string }[]) => fields.map((f) => f.id);
const notes = (fields: { type: string }[]) => fields.filter((f) => f.type === 'note');

describe('12-post-onboarding origin read', () => {
  it('degrades to a warning note when the origin cannot be read', async () => {
    const ctx = ctxFor(await repo('unreadable'));

    const detected = await postOnboardingStep.detect!(ctx);

    expect(detected).toMatchObject({
      hasGit: true,
      hasOrigin: false,
      originUrl: null,
      originError: expect.stringMatching(/git remote get-url origin failed in /),
    });
  });

  it('renders the unreadable origin as one warning note and no push fields', async () => {
    const ctx = ctxFor(await repo('unreadable'));
    const detected = await postOnboardingStep.detect!(ctx);
    const error = 'git remote get-url origin failed in /w: boom';

    const fields = postOnboardingStep.form!(ctx, {
      ...detected,
      originError: error,
    } as never)!.fields;
    expect(notes(fields)).toHaveLength(1);
    expect(notes(fields)[0]).toMatchObject({
      variant: 'warning',
      body: expect.stringContaining(error),
    });
    for (const id of ['pushToOrigin', 'credentialId', 'setUpstream']) {
      expect(fieldIds(fields)).not.toContain(id);
    }
    expect(fieldIds(fields)).toEqual(expect.arrayContaining(['commit', 'commitMessage']));
  });

  it('shows no note when there is no origin at all', async () => {
    const ctx = ctxFor(await repo('none'));

    const detected = await postOnboardingStep.detect!(ctx);

    expect(detected).toMatchObject({ hasGit: true, hasOrigin: false, originUrl: null });
    expect((detected as { originError?: string | null }).originError ?? null).toBeNull();
    const fields = postOnboardingStep.form!(ctx, detected)!.fields;
    expect(fieldIds(fields)).toEqual(['commit', 'commitMessage']);
  });

  it('offers the push fields and no note when the origin is readable', async () => {
    const ctx = ctxFor(await repo('good'));

    const detected = await postOnboardingStep.detect!(ctx);

    expect(detected).toMatchObject({ hasOrigin: true, originUrl: 'https://example.com/x.git' });
    const fields = postOnboardingStep.form!(ctx, detected)!.fields;
    expect(notes(fields)).toHaveLength(0);
    expect(fieldIds(fields)).toEqual(
      expect.arrayContaining(['pushToOrigin', 'credentialId', 'setUpstream']),
    );
  });

  it('still records artifacts and requests no push when applied after an unreadable origin', async () => {
    const ctx = await ctxForRecording(await repo('unreadable'));
    const detected = await postOnboardingStep.detect!(ctx);

    const out = await recordWritten(
      postOnboardingStep.apply(ctx, {
        detected,
        formValues: { commit: false },
      } as never),
    );

    expect(out.artifactRowsWritten).toBeGreaterThan(0);
    expect(out).toMatchObject({ commitPerformed: false, pushRequested: false });
  });

  it('reads no branch in detect', async () => {
    const ctx = ctxFor(await repo('good'));

    const detected = await postOnboardingStep.detect!(ctx);

    expect(detected).not.toHaveProperty('currentBranch');
  });

  it('answers detect the same when the branch read is killed', async () => {
    const ctx = ctxFor(await repo('good'));
    killed = await killGit(['rev-parse', '--abbrev-ref', 'HEAD']);

    const detected = await postOnboardingStep.detect!(ctx);

    expect(detected).toMatchObject({
      hasGit: true,
      hasOrigin: true,
      originUrl: 'https://example.com/x.git',
    });
  });

  it('echoes no branch from apply', async () => {
    const ctx = ctxFor(await repo('good'));
    const detected = await postOnboardingStep.detect!(ctx);

    const out = await postOnboardingStep.apply(ctx, {
      detected,
      formValues: { commit: false },
    } as never);

    expect(out).not.toHaveProperty('branch');
  });

  it('echoes no branch after git init, which still honours initBranch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'post-onboarding-init-'));
    dirs.push(root);
    await writeFile(join(root, 'AGENTS.md'), '# Agents\n');
    const ctx = ctxFor(root);
    const detected = await postOnboardingStep.detect!(ctx);
    expect(detected).toMatchObject({ hasGit: false });

    const out = await postOnboardingStep.apply(ctx, {
      detected,
      formValues: { commit: true, initBranch: 'trunk', commitMessage: 'x' },
    } as never);

    expect(out).toMatchObject({ commitPerformed: true, pushRequested: false });
    expect(out).not.toHaveProperty('branch');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('trunk');
  });
});
