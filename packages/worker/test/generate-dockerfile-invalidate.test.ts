import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { FormValues } from '@haive/shared';
import {
  COMPOSED_IMAGE_REFS_KEY,
  ComposedImageNotVerifiedError,
  composedRequestedInputsHash,
} from '../src/lsp/composed-image-refs.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { resolveSandboxImageComposition } from '../src/sandbox/composed-image-cache.js';
import type { DockerBuildOpts, DockerBuildResult } from '../src/sandbox/docker-runner.js';
import { reapOrphanEnvTemplates } from '../src/sandbox/env-template-reaper.js';
import { SANDBOX_CORE_IMAGE } from '../src/sandbox/image-composer.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  envTemplateHash,
  generateDockerfileStep,
} from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { createBuildImageStep } from '../src/step-engine/steps/env-replicate/03-build-image.js';
import { verifyEnvironmentStep } from '../src/step-engine/steps/env-replicate/04-verify-environment.js';
import { fakeDockerRunner } from './fake-docker-runner.js';

// A Dockerfile saved by step 02 over a row that is already built must not leave that build
// standing as the row's image: 03 reuses any ready row whose image still exists, and a sandbox
// composed on the environment image follows whatever image the row names. When other live tasks
// link the row it is theirs too, so the task that edits takes a row of its own instead.

const realContext = process.env.SANDBOX_CORE_CONTEXT;
beforeAll(() => {
  process.env.SANDBOX_CORE_CONTEXT = fileURLToPath(
    new URL('./fixtures/git-mcp-context', import.meta.url),
  );
});
afterAll(() => {
  if (realContext === undefined) delete process.env.SANDBOX_CORE_CONTEXT;
  else process.env.SANDBOX_CORE_CONTEXT = realContext;
});
vi.mock('../src/sandbox/sandbox-core-image.js', async (original) => ({
  ...(await original<object>()),
  ensureSandboxCoreImage: vi.fn(async () => {}),
}));

const USER = '00000000-0000-4000-8000-000000000001';
const REPO = '00000000-0000-4000-8000-000000000002';
// A task's rows are named `task-` and the first 8 characters of its id, which the two task ids
// carry so that the rows below are named as step 02's fork names its own.
const TASK = '00000003-0000-4000-8000-000000000003';
const ENV = '00000000-0000-4000-8000-000000000004';
const STEP = '00000000-0000-4000-8000-000000000005';
const PROVIDER_ID = '00000000-0000-4000-8000-000000000006';
const OTHER_ENV = '00000000-0000-4000-8000-000000000007';
const SHARER = '00000008-0000-4000-8000-000000000008';
const ENV_TAG = 'haive-env-task-00000003:latest';
// The tag 03 defaults to for a row created for the sharer's task.
const SHARER_ENV_TAG = 'haive-env-task-00000008:latest';
// The tag 03's form defaults to for a contract 2 row.
const ENV_TAG_2 = 'haive-env-task-00000003-00000000:latest';
const OLD_ID = `sha256:${'a1'.repeat(32)}`;
const NEW_ID = `sha256:${'c3'.repeat(32)}`;
const OTHER_ID = `sha256:${'d4'.repeat(32)}`;
const RETAINED_ID = `sha256:${'e5'.repeat(32)}`;
const RETAINED_TAG = 'haive-sandbox:0123456789abcdef';
const BODY_X = 'FROM node:22\nWORKDIR /app\nRUN echo x';
const BODY_Y = 'FROM node:22\nWORKDIR /app\nRUN echo y';
const LEGACY_DEPS = {};
const CONTRACT_2_DEPS = {
  lspInstallContractVersion: 2,
  lspServers: ['php-extended'],
  lspServerVersions: { php: '1.18.4' },
};
const provider = {
  id: PROVIDER_ID,
  userId: USER,
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null,
};

/** Task metadata holding a verified composed image for the provider, built from `body`. */
const retained = (body: string) => ({
  [COMPOSED_IMAGE_REFS_KEY]: {
    schemaVersion: 1,
    entries: [
      {
        providerId: PROVIDER_ID,
        effective: {
          tag: RETAINED_TAG,
          imageId: RETAINED_ID,
          identityHash: 'verified',
          inputs: {
            rtkVersion: '0.42.4',
            rtkPin: '0.42.4',
            baseImageId: 'sha256:core',
            requestedHash: composedRequestedInputsHash(body, provider, CONTRACT_2_DEPS),
          },
        },
      },
    ],
  },
});

/** docker with tags and image ids: a build moves its tag, a removal by id drops the image. */
function dockerWorld(envTag: string, extraImages: Record<string, string> = {}) {
  const tags = new Map<string, string>([
    [envTag, OLD_ID],
    [SANDBOX_CORE_IMAGE, 'sha256:core'],
    ...Object.entries(extraImages),
  ]);
  const ids = new Set<string>([...tags.values()]);
  const built: { tag: string; dockerfile: string }[] = [];
  const build = vi.fn(async (opts: DockerBuildOpts): Promise<DockerBuildResult> => {
    built.push({ tag: opts.tag, dockerfile: await readFile(opts.dockerfilePath!, 'utf8') });
    const imageId =
      opts.tag === envTag ? NEW_ID : `sha256:${String(built.length).padStart(64, '0')}`;
    tags.set(opts.tag, imageId);
    ids.add(imageId);
    return {
      exitCode: 0,
      imageTag: opts.tag,
      imageId,
      stderr: '',
      timedOut: false,
      durationMs: 1,
    };
  });
  const inspect = vi.fn(async (ref: string) => {
    const imageId = tags.get(ref) ?? (ids.has(ref) ? ref : null);
    return { exists: imageId !== null, imageId };
  });
  const remove = vi.fn(async (ref: string) => {
    const imageId = tags.get(ref) ?? ref;
    ids.delete(imageId);
    for (const [tag, id] of [...tags]) if (id === imageId) tags.delete(tag);
    return { ok: true, stderr: '' };
  });
  return { runner: fakeDockerRunner({ build, inspect, remove }), build, remove, ids, built };
}
type World = ReturnType<typeof world>;

/**
 * A task linked to one built environment row whose saved Dockerfile is BODY_X. `sharer` adds a
 * second task on the same row. The row is named for the editing task, so it holds that task's
 * default tag; `rowOf: 'sharer'` (legacy only) names it for the sharer instead.
 */
function world(
  deps: Record<string, unknown>,
  extra: {
    metadata?: unknown;
    sharer?: { status?: string; metadata?: unknown };
    rowOf?: 'sharer';
  } = {},
) {
  const envTag =
    extra.rowOf === 'sharer'
      ? SHARER_ENV_TAG
      : deps.lspInstallContractVersion === 2
        ? ENV_TAG_2
        : ENV_TAG;
  const fake = createFakeDb({
    tasks: schema.tasks,
    taskSteps: schema.taskSteps,
    envTemplates: schema.envTemplates,
    repositories: schema.repositories,
    cliProviders: schema.cliProviders,
    toolPackageVersions: schema.toolPackageVersions,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    status: 'running',
    envTemplateId: ENV,
    metadata: extra.metadata ?? {},
  });
  if (extra.sharer) {
    fake.insert(schema.tasks, {
      id: SHARER,
      userId: USER,
      repositoryId: REPO,
      status: extra.sharer.status ?? 'running',
      envTemplateId: ENV,
      metadata: extra.sharer.metadata ?? {},
    });
  }
  fake.insert(schema.taskSteps, { id: STEP, taskId: TASK, status: 'running' });
  fake.insert(schema.repositories, { id: REPO, rtkVersion: '0.42.4' });
  fake.insert(schema.cliProviders, { ...provider, enabled: true });
  fake.insert(schema.envTemplates, {
    id: ENV,
    userId: USER,
    repositoryId: REPO,
    name: extra.rowOf === 'sharer' ? 'task-00000008' : 'task-00000003',
    baseImage: 'node:22',
    declaredDeps: deps,
    generatedDockerfile: BODY_X,
    dockerfileHash: envTemplateHash(BODY_X, deps),
    imageTag: envTag,
    builtImageId: OLD_ID,
    status: 'ready',
    lastBuiltAt: new Date('2026-11-01T00:00:00Z'),
  });
  const ctx = {
    taskId: TASK,
    taskStepId: STEP,
    userId: USER,
    repoPath: '/tmp/repo',
    workspacePath: '/tmp/repo',
    cliProviderId: PROVIDER_ID,
    db: fake.db as unknown as Database,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    emitProgress: async () => {},
    sandboxWorkdir: '/haive/workdir',
    round: 0,
    signal: new AbortController().signal,
    throwIfCancelled: () => {},
  } as unknown as StepContext;
  const row = () => fake.rows(schema.envTemplates).find((r) => r.id === ENV)!;
  return { fake, ctx, row, envTag, docker: dockerWorld(envTag), db: ctx.db };
}

/** Retry 02: the form is shown again and submitted with `body`. */
async function save(w: World, body: string) {
  const detected = await generateDockerfileStep.detect!(w.ctx);
  return generateDockerfileStep.apply(w.ctx, {
    detected,
    formValues: { dockerfile: body } as FormValues,
  } as Parameters<typeof generateDockerfileStep.apply>[1]);
}

/** 03 as the auto-continue run takes it: the form's own defaults. */
async function build03(w: World) {
  const step = createBuildImageStep(w.docker.runner);
  const detected = await step.detect!(w.ctx);
  const formValues = Object.fromEntries(
    step.form!(w.ctx, detected)!.fields.map((f) => [f.id, (f as { default?: unknown }).default]),
  );
  return step.apply(w.ctx, { iteration: 0, previousIterations: [], detected, formValues });
}

const taskRow = (w: World, id: string) => w.fake.rows(schema.tasks).find((r) => r.id === id)!;
/** The row a fork inserted: any template row beyond the ones a world seeds. */
const forkRow = (w: World) =>
  w.fake.rows(schema.envTemplates).find((r) => r.id !== ENV && r.id !== OTHER_ENV);
const templateIds = (w: World) => w.fake.rows(schema.envTemplates).map((r) => r.id);

/** The tag 03's form offers the task, for the row it links. */
async function offeredTag(w: World, taskId: string) {
  const step = createBuildImageStep(w.docker.runner);
  const ctx = { ...w.ctx, taskId } as StepContext;
  const detected = await step.detect!(ctx);
  const field = step.form!(ctx, detected)!.fields.find((f) => f.id === 'imageTag');
  return (field as { default: string }).default;
}

describe('legacy row: step 02 saves a Dockerfile over a built row', () => {
  it('a changed body is built again by 03, which moves the tag and removes the superseded image', async () => {
    const w = world(LEGACY_DEPS);
    await save(w, BODY_Y);
    // Not ready, and still naming the build it supersedes.
    expect(w.row()).toMatchObject({ status: 'pending', imageTag: ENV_TAG, builtImageId: OLD_ID });
    // A launch meanwhile gets no composition on the old image.
    expect(await resolveSandboxImageComposition(w.db, TASK, provider, w.docker.runner)).toBeNull();
    const result = await build03(w);
    expect(result.skipped).toBe(false);
    expect(w.docker.build).toHaveBeenCalledTimes(1);
    expect(w.docker.built[0]!.dockerfile).toContain('RUN echo y');
    expect(w.row()).toMatchObject({ status: 'ready', imageTag: ENV_TAG, builtImageId: NEW_ID });
    expect(w.docker.remove).toHaveBeenCalledTimes(1);
    expect(w.docker.remove).toHaveBeenCalledWith(OLD_ID);
    expect(w.docker.ids.has(OLD_ID)).toBe(false);
    expect(w.docker.ids.has(NEW_ID)).toBe(true);
  });

  it('a changed body whose rebuild fails leaves the row not ready and the old image in place', async () => {
    const w = world(LEGACY_DEPS);
    await save(w, BODY_Y);
    w.docker.build.mockImplementationOnce(async (opts: DockerBuildOpts) => ({
      exitCode: 1,
      imageTag: opts.tag,
      imageId: null,
      stderr: 'controlled failure',
      timedOut: false,
      durationMs: 1,
    }));
    await expect(build03(w)).rejects.toThrow();
    expect(w.row().status).not.toBe('ready');
    expect(w.row().builtImageId).toBe(OLD_ID);
    expect(w.docker.remove).not.toHaveBeenCalled();
    expect(w.docker.ids.has(OLD_ID)).toBe(true);
  });

  it('a changed body is composed on the NEW environment image, never on the one it replaced', async () => {
    const w = world(LEGACY_DEPS);
    await save(w, BODY_Y);
    await build03(w);
    const tag = await resolveSandboxImageTag(w.db, TASK, provider, w.docker.runner);
    const composed = w.docker.built.find((b) => b.tag === tag)!;
    expect(composed.dockerfile.startsWith(`FROM ${ENV_TAG}\n`)).toBe(true);
    expect(composed.dockerfile).toContain(NEW_ID);
    expect(composed.dockerfile).not.toContain(OLD_ID);
  });

  it('the same body keeps the row ready, and 03 reuses its image', async () => {
    const w = world(LEGACY_DEPS);
    await save(w, BODY_X);
    expect(w.row()).toMatchObject({ status: 'ready', builtImageId: OLD_ID });
    const result = await build03(w);
    expect(result.skipped).toBe(true);
    expect(result.imageId).toBe(OLD_ID);
    expect(w.docker.build).not.toHaveBeenCalled();
    expect(w.docker.remove).not.toHaveBeenCalled();
  });

  it('a body another row already carries relinks the task to that row, and 03 reuses its image', async () => {
    const w = world(LEGACY_DEPS);
    w.fake.insert(schema.envTemplates, {
      id: OTHER_ENV,
      userId: USER,
      name: 'task-other',
      baseImage: 'node:22',
      declaredDeps: LEGACY_DEPS,
      generatedDockerfile: BODY_Y,
      dockerfileHash: envTemplateHash(BODY_Y, LEGACY_DEPS),
      imageTag: 'haive-env-other:latest',
      builtImageId: OTHER_ID,
      status: 'ready',
      lastBuiltAt: new Date('2026-11-02T00:00:00Z'),
    });
    w.docker.ids.add(OTHER_ID);
    const out = await save(w, BODY_Y);
    expect(out.envTemplateId).toBe(OTHER_ENV);
    const result = await build03(w);
    expect(result.skipped).toBe(true);
    expect(result.imageId).toBe(OTHER_ID);
    expect(w.docker.build).not.toHaveBeenCalled();
  });
});

describe('contract 2 row: step 02 saves a Dockerfile over a built row', () => {
  it('a changed body is not verifiable until 03 has built it again', async () => {
    const w = world(CONTRACT_2_DEPS);
    await expect(verifyEnvironmentStep.detect!(w.ctx)).resolves.toBeDefined();
    await save(w, BODY_Y);
    await expect(verifyEnvironmentStep.detect!(w.ctx)).rejects.toThrow();
    await build03(w);
    await expect(verifyEnvironmentStep.detect!(w.ctx)).resolves.toMatchObject({
      envTemplateId: ENV,
      imageRef: w.envTag,
    });
  });

  it('a changed body is composed on the new environment image only after 03 has built it', async () => {
    const w = world(CONTRACT_2_DEPS);
    const compose = () =>
      resolveSandboxImageComposition(w.db, TASK, provider, w.docker.runner, false);
    expect((await compose())?.environmentImage?.imageId).toBe(OLD_ID);
    await save(w, BODY_Y);
    expect((await compose())?.environmentImage?.imageId).not.toBe(OLD_ID);
    await build03(w);
    expect((await compose())?.environmentImage?.imageId).toBe(NEW_ID);
  });

  describe('with a verified image already retained for the provider', () => {
    const pinnedWorld = () => {
      const w = world(CONTRACT_2_DEPS, { metadata: retained(BODY_X) });
      w.docker = dockerWorld(w.envTag, { [RETAINED_TAG]: RETAINED_ID });
      return w;
    };

    it('the same body keeps launching that image', async () => {
      const w = pinnedWorld();
      await save(w, BODY_X);
      expect(w.row().status).toBe('ready');
      await expect(resolveSandboxImageTag(w.db, TASK, provider, w.docker.runner)).resolves.toBe(
        RETAINED_ID,
      );
    });

    it('a changed body refuses the launch, as it did before the row was reset', async () => {
      const w = pinnedWorld();
      await save(w, BODY_Y);
      await expect(
        resolveSandboxImageTag(w.db, TASK, provider, w.docker.runner),
      ).rejects.toBeInstanceOf(ComposedImageNotVerifiedError);
      expect(w.docker.build).not.toHaveBeenCalled();
    });
  });
});

describe('legacy row other live tasks link: step 02 saves a different Dockerfile', () => {
  it('forks: the sharer keeps the row, and the editing task links a pending row of its own', async () => {
    const w = world(LEGACY_DEPS, { sharer: {} });
    const before = structuredClone(w.row());
    const out = await save(w, BODY_Y);
    // The sharer's row is byte for byte what it was: body, hash, status, image and tag.
    expect(w.row()).toEqual(before);
    const fork = forkRow(w);
    expect(fork).toBeDefined();
    expect(out.envTemplateId).toBe(fork!.id);
    expect(taskRow(w, TASK).envTemplateId).toBe(fork!.id);
    expect(taskRow(w, SHARER).envTemplateId).toBe(ENV);
    expect(fork).toMatchObject({
      userId: USER,
      repositoryId: REPO,
      name: 'task-00000003',
      baseImage: 'node:22',
      declaredDeps: LEGACY_DEPS,
      generatedDockerfile: BODY_Y,
      dockerfileHash: envTemplateHash(BODY_Y, LEGACY_DEPS),
      status: 'pending',
      imageTag: null,
      builtImageId: null,
    });
  });

  it('the sharer keeps composing on its own environment image while the fork is built', async () => {
    const w = world(LEGACY_DEPS, { sharer: {} });
    const sharerImage = async () =>
      (await resolveSandboxImageComposition(w.db, SHARER, provider, w.docker.runner))
        ?.environmentImage;
    await save(w, BODY_Y);
    expect(await sharerImage()).toEqual({ ref: ENV_TAG, imageId: OLD_ID });
    await build03(w);
    expect(await sharerImage()).toEqual({ ref: ENV_TAG, imageId: OLD_ID });
  });

  it('03 builds the fork under a tag of its own, and the sharer tag and image stand', async () => {
    // The row was created for the editing task, so the fork carries the same name and would
    // default to the same tag: the build would move the sharer's tag onto the edited image.
    const w = world(LEGACY_DEPS, { sharer: {} });
    await save(w, BODY_Y);
    const fork = forkRow(w);
    expect(fork).toBeDefined();
    const result = await build03(w);
    expect(result.skipped).toBe(false);
    expect(w.docker.build).toHaveBeenCalledTimes(1);
    const forkTag = w.docker.built[0]!.tag;
    expect(forkTag).toBe(`haive-env-task-00000003-${String(fork!.id).slice(0, 8)}:latest`);
    expect(forkTag).not.toBe(ENV_TAG);
    expect(forkRow(w)).toMatchObject({
      status: 'ready',
      imageTag: forkTag,
      builtImageId: result.imageId,
    });
    expect(result.imageId).not.toBe(OLD_ID);
    // Nothing of the sharer's was moved or removed.
    expect(w.row()).toMatchObject({
      status: 'ready',
      generatedDockerfile: BODY_X,
      imageTag: ENV_TAG,
      builtImageId: OLD_ID,
    });
    expect((await w.docker.runner.inspect(ENV_TAG)).imageId).toBe(OLD_ID);
    expect(w.docker.remove).not.toHaveBeenCalled();
    expect(w.docker.ids.has(OLD_ID)).toBe(true);
    // The composition asserts the environment image ref's shape, so this also holds the fork's
    // tag to it; each task is composed on its own image.
    const editor = await resolveSandboxImageComposition(w.db, TASK, provider, w.docker.runner);
    expect(editor?.environmentImage).toEqual({ ref: forkTag, imageId: result.imageId });
    const sharer = await resolveSandboxImageComposition(w.db, SHARER, provider, w.docker.runner);
    expect(sharer?.environmentImage).toEqual({ ref: ENV_TAG, imageId: OLD_ID });
    // A row that holds its own default tag keeps offering it.
    expect(await offeredTag(w, SHARER)).toBe(ENV_TAG);
  });

  it('a task that joined the row forks too, and builds under a tag that is not the row tag', async () => {
    const w = world(LEGACY_DEPS, { sharer: {}, rowOf: 'sharer' });
    await save(w, BODY_Y);
    const fork = forkRow(w);
    expect(fork).toBeDefined();
    await build03(w);
    expect(w.docker.built[0]!.tag).not.toBe(SHARER_ENV_TAG);
    expect(w.row()).toMatchObject({
      status: 'ready',
      imageTag: SHARER_ENV_TAG,
      builtImageId: OLD_ID,
    });
    expect((await w.docker.runner.inspect(SHARER_ENV_TAG)).imageId).toBe(OLD_ID);
    expect(w.docker.remove).not.toHaveBeenCalled();
  });

  it('with no live task on the row it writes in place, as for an unshared row', async () => {
    const w = world(LEGACY_DEPS, { sharer: { status: 'cancelled' } });
    const out = await save(w, BODY_Y);
    expect(out.envTemplateId).toBe(ENV);
    expect(templateIds(w)).toEqual([ENV]);
    expect(taskRow(w, TASK).envTemplateId).toBe(ENV);
    expect(w.row()).toMatchObject({
      status: 'pending',
      generatedDockerfile: BODY_Y,
      imageTag: ENV_TAG,
      builtImageId: OLD_ID,
    });
  });

  it('the same body never forks, and 03 reuses the image', async () => {
    const w = world(LEGACY_DEPS, { sharer: {} });
    const out = await save(w, BODY_X);
    expect(out.envTemplateId).toBe(ENV);
    expect(templateIds(w)).toEqual([ENV]);
    expect(w.row()).toMatchObject({ status: 'ready', builtImageId: OLD_ID });
    expect((await build03(w)).skipped).toBe(true);
    expect(w.docker.build).not.toHaveBeenCalled();
  });

  describe('a row step 01 re-declared, which has no stored hash', () => {
    const reset = (w: World) =>
      w.db
        .update(schema.envTemplates)
        .set({ status: 'pending', dockerfileHash: null, imageTag: null })
        .where(eq(schema.envTemplates.id, ENV));

    it('keeps its own text without forking', async () => {
      const w = world(LEGACY_DEPS, { sharer: {} });
      await reset(w);
      const out = await save(w, BODY_X);
      expect(out.envTemplateId).toBe(ENV);
      expect(templateIds(w)).toEqual([ENV]);
      expect(w.row()).toMatchObject({
        status: 'pending',
        dockerfileHash: envTemplateHash(BODY_X, LEGACY_DEPS),
      });
    });

    it('forks when the text was edited', async () => {
      const w = world(LEGACY_DEPS, { sharer: {} });
      await reset(w);
      const out = await save(w, BODY_Y);
      expect(out.envTemplateId).not.toBe(ENV);
      expect(w.row()).toMatchObject({ generatedDockerfile: BODY_X, dockerfileHash: null });
    });

    it('the fork builds under a tag of its own though the row holds no saved tag', async () => {
      // The sharer's build form, shown before the fork, offers the name-only tag: a fork that took
      // it too would lose it to the sharer's build and name the sharer's image.
      const w = world(LEGACY_DEPS, { sharer: {} });
      await reset(w);
      expect(await offeredTag(w, SHARER)).toBe(ENV_TAG);
      await save(w, BODY_Y);
      const fork = forkRow(w);
      expect(fork).toBeDefined();
      await build03(w);
      expect(w.docker.built[0]!.tag).toBe(
        `haive-env-task-00000003-${String(fork!.id).slice(0, 8)}:latest`,
      );
      expect(await offeredTag(w, SHARER)).toBe(ENV_TAG);
    });
  });

  it('inserts the fork and links the task in one transaction', async () => {
    const w = world(LEGACY_DEPS, { sharer: {} });
    const db = w.ctx.db as unknown as {
      transaction: (fn: (tx: object) => Promise<unknown>) => Promise<unknown>;
    };
    const real = db.transaction.bind(db);
    // Fail the statement that links the task, inside the transaction.
    db.transaction = (fn) =>
      real((tx) =>
        fn(
          new Proxy(tx, {
            get: (target, key, receiver) =>
              key === 'update'
                ? () => {
                    throw new Error('link failed');
                  }
                : Reflect.get(target, key, receiver),
          }),
        ),
      );
    await expect(save(w, BODY_Y)).rejects.toThrow();
    expect(templateIds(w)).toEqual([ENV]);
    expect(taskRow(w, TASK).envTemplateId).toBe(ENV);
  });

  it('a redelivered apply lands on the fork it made, and inserts no second one', async () => {
    const w = world(LEGACY_DEPS, { sharer: {} });
    // The persisted detect output still names the shared row.
    const detected = await generateDockerfileStep.detect!(w.ctx);
    const args = {
      detected,
      formValues: { dockerfile: BODY_Y } as FormValues,
    } as Parameters<typeof generateDockerfileStep.apply>[1];
    const first = await generateDockerfileStep.apply(w.ctx, args);
    const second = await generateDockerfileStep.apply(w.ctx, args);
    expect(first.envTemplateId).not.toBe(ENV);
    expect(second.envTemplateId).toBe(first.envTemplateId);
    expect(templateIds(w)).toHaveLength(2);
    expect(taskRow(w, TASK).envTemplateId).toBe(first.envTemplateId);
    expect(taskRow(w, SHARER).envTemplateId).toBe(ENV);
  });

  it('the row the editor left is not reaped while its sharer lives', async () => {
    const w = world(LEGACY_DEPS, { sharer: {} });
    await save(w, BODY_Y);
    expect(forkRow(w)).toBeDefined();
    // A build that failed makes the row reapable.
    await w.db
      .update(schema.envTemplates)
      .set({ status: 'failed' })
      .where(eq(schema.envTemplates.id, ENV));
    await reapOrphanEnvTemplates(w.db, w.docker.runner);
    expect(templateIds(w)).toContain(ENV);
    // The same sweep takes it once no live task links it.
    await w.db.update(schema.tasks).set({ status: 'completed' }).where(eq(schema.tasks.id, SHARER));
    await reapOrphanEnvTemplates(w.db, w.docker.runner);
    expect(templateIds(w)).not.toContain(ENV);
    expect(forkRow(w)).toBeDefined();
  });
});

describe('contract 2 row other live tasks link: step 02 saves a different Dockerfile', () => {
  it('the fork carries the declared deps, so it is verified like an unshared row', async () => {
    const w = world(CONTRACT_2_DEPS, { sharer: {} });
    const sharerCtx = { ...w.ctx, taskId: SHARER } as StepContext;
    await save(w, BODY_Y);
    const fork = forkRow(w);
    expect(fork).toBeDefined();
    expect(fork!.declaredDeps).toEqual(CONTRACT_2_DEPS);
    // Not verifiable until 03 has built it; the sharer's row still is.
    await expect(verifyEnvironmentStep.detect!(w.ctx)).rejects.toThrow();
    await expect(verifyEnvironmentStep.detect!(sharerCtx)).resolves.toMatchObject({
      envTemplateId: ENV,
      imageRef: ENV_TAG_2,
    });
    await build03(w);
    const forkTag = w.docker.built[0]!.tag;
    expect(forkTag).toBe(`haive-env-task-00000003-${String(fork!.id).slice(0, 8)}:latest`);
    expect(forkTag).not.toBe(ENV_TAG_2);
    await expect(verifyEnvironmentStep.detect!(w.ctx)).resolves.toMatchObject({
      envTemplateId: fork!.id,
      imageRef: forkTag,
    });
    await expect(verifyEnvironmentStep.detect!(sharerCtx)).resolves.toMatchObject({
      envTemplateId: ENV,
      imageRef: ENV_TAG_2,
    });
    expect(w.row()).toMatchObject({ status: 'ready', imageTag: ENV_TAG_2, builtImageId: OLD_ID });
  });

  it('each task is composed on its own environment image', async () => {
    const w = world(CONTRACT_2_DEPS, { sharer: {} });
    const compose = async (taskId: string) =>
      (await resolveSandboxImageComposition(w.db, taskId, provider, w.docker.runner, false))
        ?.environmentImage;
    await save(w, BODY_Y);
    expect(await compose(SHARER)).toEqual({ ref: ENV_TAG_2, imageId: OLD_ID });
    await build03(w);
    const forkTag = w.docker.built[0]!.tag;
    expect(await compose(SHARER)).toEqual({ ref: ENV_TAG_2, imageId: OLD_ID });
    expect(await compose(TASK)).toMatchObject({ ref: forkTag });
    expect((await compose(TASK))?.imageId).not.toBe(OLD_ID);
  });

  it('a pinned launch keeps its image for the sharer, and is refused for the editor whose body changed', async () => {
    const w = world(CONTRACT_2_DEPS, {
      metadata: retained(BODY_X),
      sharer: { metadata: retained(BODY_X) },
    });
    w.docker = dockerWorld(w.envTag, { [RETAINED_TAG]: RETAINED_ID });
    await save(w, BODY_Y);
    await expect(resolveSandboxImageTag(w.db, SHARER, provider, w.docker.runner)).resolves.toBe(
      RETAINED_ID,
    );
    await expect(
      resolveSandboxImageTag(w.db, TASK, provider, w.docker.runner),
    ).rejects.toBeInstanceOf(ComposedImageNotVerifiedError);
    expect(w.docker.build).not.toHaveBeenCalled();
  });
});
