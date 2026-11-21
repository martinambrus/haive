import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { ensureComposedImage } from '../src/sandbox/composed-image-cache.js';
import {
  composeSandboxImage,
  SANDBOX_CORE_IMAGE,
  type ComposeInput,
} from '../src/sandbox/image-composer.js';
import type { DockerBuildOpts } from '../src/sandbox/docker-runner.js';
import { ensureSandboxCoreImage } from '../src/sandbox/sandbox-core-image.js';
import { fakeDockerRunner } from './fake-docker-runner.js';

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

const EXTRA = `RUN echo from ${SANDBOX_CORE_IMAGE}`;
const provider = {
  id: 'p',
  userId: 'u',
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null as string | null,
  enabled: true,
  wrapperContent: null,
  envVars: null,
};
const namingProvider = { ...provider, sandboxDockerfileExtra: EXTRA };
const plainBody = 'FROM node:22\nWORKDIR /app\nRUN echo hi\n';
const copyBody = `FROM node:22\nWORKDIR /app\nCOPY composer.json composer.lock ./\nRUN composer install\n`;
const nodeBody = 'FROM node:22\nRUN echo hi\n';
const coreBody = `FROM ${SANDBOX_CORE_IMAGE}\nRUN echo x\n`;
const ENV_TAG = 'haive-env:abc123';
const ENV_ID = 'sha256:envid1';
const CORE_ID = 'sha256:core';
const env = { ref: ENV_TAG, imageId: ENV_ID };
const contract2 = {
  lspInstallContractVersion: 2,
  lspServers: ['php-extended'],
  lspServerVersions: { php: '1.18.4' },
};
const compose = (envBody: string | null, extra: Partial<ComposeInput> = {}, extraText?: string) =>
  composeSandboxImage({
    envTemplateDockerfile: envBody,
    provider: {
      name: 'claude-code',
      cliVersion: '1.2.3',
      sandboxDockerfileExtra: extraText ?? null,
    },
    rtkVersion: '0.42.4',
    ...extra,
  });

interface EnvRow {
  imageTag: string | null;
  builtImageId: string | null;
}
const okRow: EnvRow = { imageTag: ENV_TAG, builtImageId: ENV_ID };
function database(declaredDeps: unknown, envBody: string, row: EnvRow, prov = provider) {
  return {
    query: {
      tasks: {
        findFirst: async () => ({
          id: 't',
          userId: 'u',
          envTemplateId: 'env',
          repositoryId: 'repo',
          metadata: {},
        }),
      },
      envTemplates: {
        findFirst: async () => ({
          id: 'env',
          status: 'ready',
          generatedDockerfile: envBody,
          declaredDeps,
          ...row,
        }),
      },
      cliProviders: { findFirst: async () => prov },
      repositories: { findFirst: async () => ({ rtkVersion: '0.42.4' }) },
      toolPackageVersions: {
        findFirst: async () => {
          throw new Error('pinned RTK must not query latest');
        },
      },
      taskSteps: { findFirst: async () => undefined },
    },
  } as unknown as Database;
}
const result = (opts: DockerBuildOpts) => ({
  exitCode: 0,
  imageTag: opts.tag,
  imageId: 'sha256:built',
  stdout: '',
  stderr: '',
  error: undefined,
  timedOut: false,
  durationMs: 1,
});
function dockerLike() {
  const images = new Set<string>([SANDBOX_CORE_IMAGE]);
  const build = vi.fn(async (opts: DockerBuildOpts) => {
    await readFile(opts.dockerfilePath!, 'utf8');
    await readdir(opts.contextDir);
    images.add(opts.tag);
    return result(opts);
  });
  const inspect = vi.fn(async (ref: string) => {
    if (ref === ENV_TAG) return { exists: true, imageId: ENV_ID };
    if (ref === SANDBOX_CORE_IMAGE) return { exists: true, imageId: CORE_ID };
    return { exists: images.has(ref), imageId: images.has(ref) ? 'sha256:x' : null };
  });
  const remove = vi.fn(async (ref: string) => {
    images.delete(ref);
    return { ok: true, stderr: '' };
  });
  return fakeDockerRunner({ build, inspect, remove });
}

beforeEach(() => {
  vi.mocked(ensureSandboxCoreImage).mockClear();
});

const LEGACY_DEPS = [{}, { lspInstallContractVersion: 1 }];

describe('launch: the core image is ensured only for a composition that names it', () => {
  it.each(LEGACY_DEPS)('B1 declaredDeps %j on its environment image', async (declared) => {
    const tag = await resolveSandboxImageTag(
      database(declared, plainBody, okRow),
      't',
      provider,
      dockerLike(),
    );
    expect(ensureSandboxCoreImage).not.toHaveBeenCalled();
    expect(tag).toBe(compose(plainBody, { environmentImage: env }).tag);
  });
  it('B2 a pasted body on another image', async () => {
    const tag = await resolveSandboxImageTag(
      database({}, nodeBody, { imageTag: null, builtImageId: ENV_ID }),
      't',
      provider,
      dockerLike(),
    );
    expect(ensureSandboxCoreImage).not.toHaveBeenCalled();
    expect(tag).toBe(compose(nodeBody, { baseImageId: CORE_ID }).tag);
  });
  it('B3 a pasted body on the core image', async () => {
    const tag = await resolveSandboxImageTag(
      database({}, coreBody, { imageTag: null, builtImageId: ENV_ID }),
      't',
      provider,
      dockerLike(),
    );
    expect(ensureSandboxCoreImage).toHaveBeenCalledTimes(1);
    expect(tag).toBe(compose(coreBody, { baseImageId: CORE_ID }).tag);
  });
  it('B4 an environment image with an extra naming the core', async () => {
    const tag = await resolveSandboxImageTag(
      database({}, plainBody, okRow, namingProvider),
      't',
      namingProvider,
      dockerLike(),
    );
    expect(ensureSandboxCoreImage).toHaveBeenCalledTimes(1);
    const named = compose(plainBody, { environmentImage: env, baseImageId: CORE_ID }, EXTRA);
    expect(tag).toBe(named.tag);
    expect(tag).not.toBe(
      compose(plainBody, { environmentImage: env, baseImageId: 'sha256:other' }, EXTRA).tag,
    );
  });
});

describe('verification: contract 2 ensures the core image only for a composition that names it', () => {
  const deps = contract2;
  it('C1 an environment image alone', async () => {
    const tag = await ensureComposedImage(
      database(deps, copyBody, okRow),
      't',
      provider,
      dockerLike(),
    );
    expect(ensureSandboxCoreImage).not.toHaveBeenCalled();
    expect(tag).toBe('haive-sandbox:ee0f9802e3b7c479');
    expect(tag).toBe(compose(copyBody, { ...contract2, environmentImage: env }).tag);
  });
  it('C2 an environment image with an extra naming the core', async () => {
    await ensureComposedImage(
      database(deps, plainBody, okRow, namingProvider),
      't',
      namingProvider,
      dockerLike(),
    );
    expect(ensureSandboxCoreImage).toHaveBeenCalledTimes(1);
  });
});

describe('D hash parity', () => {
  it('tags are pinned', () => {
    const kinds: Record<string, string> = {
      envNull: compose(null).tag,
      envNullBase: compose(null, { baseImageId: CORE_ID }).tag,
      b1: compose(plainBody, { environmentImage: env }).tag,
      b2: compose(nodeBody, { baseImageId: CORE_ID }).tag,
      b3: compose(coreBody, { baseImageId: CORE_ID }).tag,
      b4: compose(plainBody, { environmentImage: env, baseImageId: CORE_ID }, EXTRA).tag,
      c1: compose(copyBody, { ...contract2, environmentImage: env }).tag,
      c2: compose(copyBody, { ...contract2, environmentImage: env, baseImageId: CORE_ID }, EXTRA)
        .tag,
    };
    expect(kinds).toEqual({
      envNull: 'haive-sandbox:64881a8fed51baad',
      envNullBase: 'haive-sandbox:173ea82207d681b1',
      b1: 'haive-sandbox:9abf473735c5e242',
      b2: 'haive-sandbox:57c799453a089d09',
      b3: 'haive-sandbox:049e3d8ca8b6f6c6',
      b4: 'haive-sandbox:b68fb5c876904cf3',
      c1: 'haive-sandbox:ee0f9802e3b7c479',
      c2: 'haive-sandbox:b73d1387027e3bfe',
    });
  });
});
