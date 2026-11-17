import { beforeEach, expect, it, vi } from 'vitest';
import { type Database } from '@haive/database';
import { fakeDockerRunner } from './fake-docker-runner.js';
const core = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../src/sandbox/sandbox-core-image.js', async (original) => ({
  ...(await original<object>()),
  ensureSandboxCoreImage: core,
}));
vi.mock('../src/sandbox/image-cache.js', async (original) => {
  const actual = await original<typeof import('../src/sandbox/image-cache.js')>();
  return {
    ...actual,
    resolveImageTag: (p: Parameters<typeof actual.resolveImageTag>[0]) =>
      p.providerId === 'fallback' ? null : actual.resolveImageTag(p),
  };
});
import { peekSandboxImageTag, resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { composeSandboxImage, SANDBOX_CORE_IMAGE } from '../src/sandbox/image-composer.js';
import { resolveImageTag } from '../src/sandbox/image-cache.js';
const ID = `sha256:${'a'.repeat(64)}`;
const provider = {
  id: 'p',
  userId: 'u',
  name: 'codex' as const,
  cliVersion: '1.0.0',
  sandboxDockerfileExtra: null,
};
function database(dockerfile?: string) {
  return {
    query: {
      tasks: {
        findFirst: async () => ({ envTemplateId: dockerfile ? 'e' : null, repositoryId: null }),
      },
      envTemplates: {
        findFirst: async () => ({ status: 'ready', generatedDockerfile: dockerfile }),
      },
      toolPackageVersions: { findFirst: async () => null },
    },
  } as unknown as Database;
}
beforeEach(() => core.mockClear());
it('uses the identical composed calculation without ensuring or building the base', async () => {
  const db = database(`FROM ${SANDBOX_CORE_IMAGE}`);
  const tag = composeSandboxImage({
    envTemplateDockerfile: `FROM ${SANDBOX_CORE_IMAGE}`,
    provider,
    baseImageId: ID,
  }).tag;
  const inspect = vi.fn(async (ref: string) => ({
    exists: ref === SANDBOX_CORE_IMAGE || ref === tag,
    imageId: ID,
  }));
  const runner = fakeDockerRunner({ inspect });
  expect(await peekSandboxImageTag(db, 't', provider, runner)).toEqual({ tag, imageId: ID });
  expect(core).not.toHaveBeenCalled();
  expect(await resolveSandboxImageTag(db, 't', provider, runner)).toBe(tag);
  expect(core).toHaveBeenCalledTimes(1);
});
it('returns null for an unbuilt composed image instead of advertising a provider fallback', async () => {
  const runner = fakeDockerRunner({
    inspect: async (ref) => ({ exists: ref === SANDBOX_CORE_IMAGE, imageId: ID }),
  });
  expect(
    await peekSandboxImageTag(database('FROM ubuntu:24.04'), 't', provider, runner),
  ).toBeNull();
  expect(core).not.toHaveBeenCalled();
});
it('agrees on the provider arm and reads a changed ID afresh on every peek', async () => {
  const tag = resolveImageTag({ ...provider, providerId: provider.id })!.tag;
  let imageId = ID;
  const runner = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId }) });
  const db = database();
  expect(await peekSandboxImageTag(db, 't', provider, runner)).toEqual({ tag, imageId });
  expect(await resolveSandboxImageTag(db, 't', provider, runner)).toBe(tag);
  imageId = `sha256:${'b'.repeat(64)}`;
  expect((await peekSandboxImageTag(db, 't', provider, runner))?.imageId).toBe(imageId);
  expect(core).not.toHaveBeenCalled();
});
it('peeks the configured base fallback, and a missing image answers null', async () => {
  // All current providers install a CLI; exercise the retained no-derived-image fallback through its seam.
  const noInstall = { ...provider, id: 'fallback' };
  const inspect = vi.fn(async () => ({ exists: true, imageId: ID }));
  const runner = fakeDockerRunner({ inspect });
  expect(await resolveSandboxImageTag(database(), 't', noInstall, runner)).toBeNull();
  expect(await peekSandboxImageTag(database(), 't', noInstall, runner)).toEqual({
    tag: process.env.SANDBOX_IMAGE ?? SANDBOX_CORE_IMAGE,
    imageId: ID,
  });
  expect(core).not.toHaveBeenCalled();
  inspect.mockResolvedValue({ exists: false, imageId: null as unknown as string });
  expect(await peekSandboxImageTag(database(), 't', noInstall, runner)).toBeNull();
});

it('inspects the core once for an entire provider batch', async () => {
  const { createSandboxImagePeekBatch } = await import('../src/queues/cli-exec/images.js');
  const inspect = vi.fn(async (_ref: string) => ({ exists: true, imageId: ID }));
  const runner = fakeDockerRunner({ inspect });
  const batch = createSandboxImagePeekBatch(runner);
  await Promise.all(
    [provider, { ...provider, id: 'p2', name: 'gemini' }].map((p) =>
      peekSandboxImageTag(database(`FROM ${SANDBOX_CORE_IMAGE}`), 't', p, runner, batch),
    ),
  );
  expect(inspect.mock.calls.filter(([tag]) => tag === SANDBOX_CORE_IMAGE)).toHaveLength(1);
});

it.each(['launch', 'peek'] as const)('ordinary %s reads task/template only once', async (kind) => {
  const db = database('FROM ubuntu:24.04');
  const task = vi.spyOn(db.query.tasks, 'findFirst');
  const env = vi.spyOn(db.query.envTemplates, 'findFirst');
  const tools = vi.spyOn(db.query.toolPackageVersions, 'findFirst');
  const runner = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: ID }) });
  if (kind === 'launch') await resolveSandboxImageTag(db, 't', provider, runner);
  else await peekSandboxImageTag(db, 't', provider, runner);
  expect([task.mock.calls.length, env.mock.calls.length, tools.mock.calls.length]).toEqual([
    1, 1, 1,
  ]);
});
