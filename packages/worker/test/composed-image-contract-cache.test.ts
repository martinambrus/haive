import { composedRequestedInputsHash } from '../src/lsp/composed-image-refs.js';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  ensureComposedImage,
  resolveSandboxImageComposition,
} from '../src/sandbox/composed-image-cache.js';
import {
  composeSandboxImage,
  SANDBOX_CORE_IMAGE,
  type ComposeInput,
} from '../src/sandbox/image-composer.js';
import { peekSandboxImageTag, resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import type { DockerBuildOpts } from '../src/sandbox/docker-runner.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({
  ensureSandboxCoreImage: vi.fn(async () => {}),
}));

const provider = {
  id: 'p',
  userId: 'u',
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null,
};
const body = `FROM ${SANDBOX_CORE_IMAGE}\nRUN echo saved-body\n`;
const ID = 'sha256:core';
const deps = {
  lspInstallContractVersion: 2,
  lspServers: ['php-extended'],
  lspServerVersions: { php: '1.18.4' },
};
function database(
  declaredDeps: unknown = deps,
  opts: { linked?: boolean; status?: string; dockerfile?: string | null; metadata?: unknown } = {},
) {
  return {
    query: {
      tasks: {
        findFirst: async () => ({
          envTemplateId: opts.linked === false ? null : 'env',
          repositoryId: 'repo',
          metadata: opts.metadata,
        }),
      },
      envTemplates: {
        findFirst: vi.fn(async () => ({
          status: opts.status ?? 'ready',
          generatedDockerfile: opts.dockerfile === undefined ? body : opts.dockerfile,
          declaredDeps,
        })),
      },
      cliProviders: { findFirst: async () => provider },
      repositories: { findFirst: async () => ({ rtkVersion: '0.42.4' }) },
      toolPackageVersions: {
        findFirst: async () => {
          throw new Error('pinned RTK must not query latest');
        },
      },
    },
  } as unknown as Database;
}
const expected = () =>
  composeSandboxImage({
    envTemplateDockerfile: body,
    provider,
    baseImageId: ID,
    rtkVersion: '0.42.4',
    ...deps,
  } as ComposeInput);
const buildResult = (imageTag: string, exitCode = 0) => ({
  exitCode,
  imageTag,
  imageId: 'sha256:built',
  stdout: '',
  stderr: 'controlled failure',
  timedOut: false,
  durationMs: 1,
});

it('peek and ensure consume the saved contract/selection/pins and the same base and RTK', async () => {
  const image = expected();
  const build = vi.fn();
  const runner = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: ID }), build });
  const db = database(deps, {
    metadata: {
      composedLspImageRefs: {
        schemaVersion: 1,
        entries: [
          {
            providerId: provider.id,
            effective: {
              tag: image.tag,
              imageId: ID,
              identityHash: 'verified',
              inputs: {
                rtkVersion: '0.42.4',
                rtkPin: '0.42.4',
                baseImageId: ID,
                requestedHash: composedRequestedInputsHash(body, provider, deps),
              },
            },
          },
        ],
      },
    },
  });
  expect(await resolveSandboxImageComposition(db, 't', provider, runner)).toMatchObject(image);
  expect(image.dockerfileBody).toContain('intelephense@1.18.4');
  expect(await peekSandboxImageTag(db, 't', provider, runner)).toEqual({
    tag: image.tag,
    imageId: ID,
  });
  expect(await resolveSandboxImageTag(db, 't', provider, runner)).toBe(ID);
  expect(build).not.toHaveBeenCalled();
});
it('a contract-2 miss peeks unknown, then ensure builds the exact requested body without fallback', async () => {
  const image = expected();
  const images = new Set([SANDBOX_CORE_IMAGE]);
  const build = vi.fn(async (opts: DockerBuildOpts) => {
    expect(opts.tag).toBe(image.tag);
    expect(await readFile(opts.dockerfilePath!, 'utf8')).toBe(image.dockerfileBody);
    images.add(opts.tag);
    return buildResult(opts.tag);
  });
  const runner = fakeDockerRunner({
    inspect: async (ref) => ({ exists: images.has(ref), imageId: ID }),
    build,
  });
  const db = database();
  expect(await peekSandboxImageTag(db, 't', provider, runner)).toBeNull();
  expect(build).not.toHaveBeenCalled();
  await expect(resolveSandboxImageTag(db, 't', provider, runner)).rejects.toThrow(
    /verification after the plugin result/,
  );
  expect(await ensureComposedImage(db, 't', provider, runner)).toBe(image.tag);
  expect(await peekSandboxImageTag(db, 't', provider, runner)).toBeNull();
  const published = database(deps, {
    metadata: {
      composedLspImageRefs: {
        schemaVersion: 1,
        entries: [
          {
            providerId: provider.id,
            effective: {
              tag: image.tag,
              imageId: ID,
              identityHash: 'verified',
              inputs: {
                rtkVersion: '0.42.4',
                rtkPin: '0.42.4',
                baseImageId: ID,
                requestedHash: composedRequestedInputsHash(body, provider, deps),
              },
            },
          },
        ],
      },
    },
  });
  expect(await resolveSandboxImageTag(published, 't', provider, runner)).toBe(ID);
  expect(await peekSandboxImageTag(published, 't', provider, runner)).toEqual({
    tag: image.tag,
    imageId: ID,
  });
  expect(build).toHaveBeenCalledTimes(1);
});
it('rejects unknown metadata before a non-ready or missing-body template can fall back', async () => {
  const runner = fakeDockerRunner();
  for (const opts of [{}, { status: 'building' }, { dockerfile: null }]) {
    const db = database({ lspInstallContractVersion: 99 }, opts);
    await expect(peekSandboxImageTag(db, 't', provider, runner)).rejects.toThrow(
      'Unsupported LSP install contract',
    );
    await expect(resolveSandboxImageTag(db, 't', provider, runner)).rejects.toThrow(
      'Unsupported LSP install contract',
    );
  }
});
it('refuses an unsupported CLI for contract 2 before any image operation', async () => {
  const runner = fakeDockerRunner();
  const unsupported = { ...provider, name: 'codex' };
  await expect(peekSandboxImageTag(database(), 't', unsupported, runner)).rejects.toThrow(
    /codex.*LSP/,
  );
  await expect(resolveSandboxImageTag(database(), 't', unsupported, runner)).rejects.toThrow(
    /codex.*LSP/,
  );
});
it('explicitly has no composed decision without an environment template', async () => {
  const db = database(deps, { linked: false });
  expect(await resolveSandboxImageComposition(db, 't', provider, fakeDockerRunner())).toBeNull();
  expect(db.query.envTemplates.findFirst).not.toHaveBeenCalled();
});
it('a failed pin replacement preserves the old image and rejects the requested tag', async () => {
  const old = expected();
  const db = database({ ...deps, lspServerVersions: { php: '1.18.5' } });
  const images = new Set([SANDBOX_CORE_IMAGE, old.tag]);
  const build = vi.fn(async (opts: DockerBuildOpts) => {
    expect(opts.tag).not.toBe(old.tag);
    expect(await readFile(opts.dockerfilePath!, 'utf8')).toContain('intelephense@1.18.5');
    return buildResult(opts.tag, 1);
  });
  const runner = fakeDockerRunner({
    inspect: async (ref) => ({ exists: images.has(ref), imageId: ID }),
    build,
  });
  await expect(resolveSandboxImageTag(db, 't', provider, runner)).rejects.toThrow(
    /verification after the plugin result/,
  );
  await expect(ensureComposedImage(db, 't', provider, runner)).rejects.toThrow(
    'controlled failure',
  );
  expect(build).toHaveBeenCalledTimes(1);
  expect(images.has(old.tag)).toBe(true);
  expect(await peekSandboxImageTag(db, 't', provider, runner)).toBeNull();
  expect(await ensureComposedImage(database(), 't', provider, runner)).toBe(old.tag);
});
it('serializes simultaneous ensures of one tag and builds it once', async () => {
  const image = expected();
  const images = new Set([SANDBOX_CORE_IMAGE]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const build = vi.fn(async (opts: DockerBuildOpts) => {
    await gate;
    images.add(opts.tag);
    return buildResult(opts.tag);
  });
  const runner = fakeDockerRunner({
    inspect: async (ref) => ({ exists: images.has(ref), imageId: ID }),
    build,
  });
  const db = database();
  const first = ensureComposedImage(db, 't', provider, runner);
  const second = ensureComposedImage(db, 't', provider, runner);
  release();
  expect(await Promise.all([first, second])).toEqual([image.tag, image.tag]);
  expect(build).toHaveBeenCalledTimes(1);
});

it('keeps a cached contract-2 image unknown to peek until verification publishes it', async () => {
  const runner = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: ID }) });
  expect(await peekSandboxImageTag(database(), 't', provider, runner)).toBeNull();
});

it('refuses a peek when the provider moved after the caller captured its configuration', async () => {
  const image = expected();
  const db = database(deps, {
    metadata: {
      composedLspImageRefs: {
        schemaVersion: 1,
        entries: [
          {
            providerId: provider.id,
            effective: {
              tag: image.tag,
              imageId: ID,
              identityHash: 'verified',
              inputs: {
                rtkVersion: '0.42.4',
                rtkPin: '0.42.4',
                baseImageId: ID,
                requestedHash: composedRequestedInputsHash(body, provider, deps),
              },
            },
          },
        ],
      },
    },
  });
  vi.spyOn(db.query.cliProviders, 'findFirst').mockResolvedValue({
    ...provider,
    cliVersion: '2.0.0',
  } as never);
  const runner = fakeDockerRunner({ inspect: async () => ({ exists: true, imageId: ID }) });
  expect(await peekSandboxImageTag(db, 't', provider, runner)).toBeNull();
});
