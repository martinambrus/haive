import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { ComposedImageNotVerifiedError } from '../src/lsp/composed-image-refs.js';
import { composedRequestedInputsHash } from '../src/lsp/composed-image-refs.js';
import { loadComposedLspIdentity } from '../src/lsp/composed-evidence.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import {
  ensureComposedImage,
  withResolvedComposedImage,
  type ResolvedSandboxImageComposition,
} from '../src/sandbox/composed-image-cache.js';
import {
  composeSandboxImage,
  SANDBOX_CORE_IMAGE,
  type ComposeInput,
} from '../src/sandbox/image-composer.js';
import type { DockerBuildOpts } from '../src/sandbox/docker-runner.js';
import { ensureSandboxCoreImage } from '../src/sandbox/sandbox-core-image.js';
import { fakeDockerRunner } from './fake-docker-runner.js';

// The goldens pin the composer's own bytes; the git MCP layer's digest comes from a stub context,
// so bumping the real lock does not move them.
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

const provider = {
  id: 'p',
  userId: 'u',
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null,
  enabled: true,
  wrapperContent: null,
  envVars: null,
};
const COPY_LINE = 'COPY composer.json composer.lock ./';
const body = `FROM node:22\nWORKDIR /app\n${COPY_LINE}\nRUN composer install\n`;
const deps = {
  lspInstallContractVersion: 2,
  lspServers: ['php-extended'],
  lspServerVersions: { php: '1.18.4' },
};
const ENV_TAG = 'haive-env:abc123';
const ENV_ID = 'sha256:envid1';
const CORE_ID = 'sha256:core';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const legacyProvider = {
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null,
};
const compose = (extra: Partial<ComposeInput> & Record<string, unknown> = {}) =>
  composeSandboxImage({
    envTemplateDockerfile: body,
    provider: legacyProvider,
    rtkVersion: '0.42.4',
    ...extra,
  });
const contract2 = deps;

describe('A composer from the environment image', () => {
  const env = { ref: ENV_TAG, imageId: ENV_ID };
  it('contract 2 + environmentImage starts FROM the env ref and does not paste the body', () => {
    const c = compose({ ...contract2, environmentImage: env });
    expect(
      c.dockerfileBody.startsWith(`FROM ${ENV_TAG}\n# haive-environment-image: ${ENV_ID}\n`),
    ).toBe(true);
    expect(c.dockerfileBody).not.toContain(COPY_LINE);
    expect(c.dockerfileBody).toContain('# haive-lsp-install-contract: 2');
  });
  it('a different environment image id yields a different tag', () => {
    const a = compose({ ...contract2, environmentImage: env });
    const b = compose({
      ...contract2,
      environmentImage: { ref: ENV_TAG, imageId: 'sha256:envid2' },
    });
    expect(a.tag).not.toBe(b.tag);
  });
  it('contract 2 without the field equals the unchanged output', () => {
    expect(compose(contract2)).toMatchObject({
      tag: 'haive-sandbox:19e600548bec9184',
      hash: '19e600548bec9184',
    });
    expect(sha(compose(contract2).dockerfileBody)).toBe(
      '19e600548bec918466786c07f989d8726d68528bba1246f798355fa20ee17152',
    );
  });
  it('a legacy row builds FROM the env ref too, without the LSP marker', () => {
    for (const lspInstallContractVersion of [undefined, 1]) {
      const c = compose({ lspInstallContractVersion, environmentImage: env });
      expect(
        c.dockerfileBody.startsWith(`FROM ${ENV_TAG}\n# haive-environment-image: ${ENV_ID}\n`),
      ).toBe(true);
      expect(c.dockerfileBody).not.toContain(COPY_LINE);
      expect(c.dockerfileBody).not.toContain('# haive-lsp-install-contract: 2');
    }
  });
  it.each([
    ['ref newline', { ref: 'a\nRUN x', imageId: ENV_ID }],
    ['ref space', { ref: 'a b', imageId: ENV_ID }],
    ['imageId newline', { ref: ENV_TAG, imageId: 'sha256:a\nRUN x' }],
    ['imageId space', { ref: ENV_TAG, imageId: 'sha256:a b' }],
  ])('throws on %s', (_label, bad) => {
    expect(() => compose({ ...contract2, environmentImage: bad })).toThrow(Error);
  });
});

describe('B legacy golden', () => {
  const golden = (
    input: Parameters<typeof composeSandboxImage>[0],
    tag: string,
    bodySha: string,
  ) => {
    const c = composeSandboxImage(input);
    expect(c.tag).toBe(`haive-sandbox:${tag}`);
    expect(c.hash).toBe(tag);
    expect(sha(c.dockerfileBody)).toBe(bodySha);
  };
  it('no env template', () =>
    golden(
      { envTemplateDockerfile: null, provider: legacyProvider },
      '83c5089a241f3504',
      '83c5089a241f3504995f4f39a2c9983c824c5e80c20d07861833cbd0abce3014',
    ));
  it('env body', () =>
    golden(
      {
        envTemplateDockerfile: 'FROM debian:12\nRUN echo hi\n',
        provider: legacyProvider,
        rtkVersion: '0.42.4',
      },
      '1e7ed04332720485',
      '1e7ed0433272048577774474ec7d944eba5793e42bfd4290a13ab51cf7092650',
    ));
  it('env body with the COPY line, contract absent and explicit 1', () => {
    for (const lspInstallContractVersion of [undefined, 1]) {
      golden(
        {
          envTemplateDockerfile: body,
          provider: legacyProvider,
          rtkVersion: '0.42.4',
          lspInstallContractVersion,
        },
        'b413570a412022a8',
        'b413570a412022a857427ed69e890d54152c304ec96028875ffbdc9bc3b2f844',
      );
    }
  });
  it('extras and an rtk pin', () =>
    golden(
      {
        envTemplateDockerfile: body,
        provider: { ...legacyProvider, sandboxDockerfileExtra: 'RUN echo extra' },
        rtkVersion: '0.40.0',
      },
      '008e3ecc8250291f',
      '008e3ecc8250291f2ff5f756d49e7cf9c5eb1f402c8c9ce8cc5cad25ff983695',
    ));
  it('env body on the core image mixes the base id', () =>
    golden(
      {
        envTemplateDockerfile: `FROM ${SANDBOX_CORE_IMAGE}\nRUN echo x\n`,
        provider: legacyProvider,
        baseImageId: 'sha256:core',
        rtkVersion: '0.42.4',
      },
      '049e3d8ca8b6f6c6',
      '3b9e44f64ef69157d37dade15a9de2d4d5f0930351ba9033c43060e746eef9fa',
    ));
});

interface EnvRow {
  imageTag: string | null;
  builtImageId: string | null;
}
function database(
  env: EnvRow = { imageTag: ENV_TAG, builtImageId: ENV_ID },
  metadata: unknown = undefined,
  declaredDeps: unknown = deps,
) {
  return {
    query: {
      tasks: {
        findFirst: async () => ({
          id: 't',
          userId: 'u',
          envTemplateId: 'env',
          repositoryId: 'repo',
          metadata,
        }),
      },
      envTemplates: {
        findFirst: async () => ({
          id: 'env',
          status: 'ready',
          generatedDockerfile: body,
          declaredDeps,
          ...env,
        }),
      },
      cliProviders: { findFirst: async () => provider },
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
const result = (opts: DockerBuildOpts, exitCode = 0, error?: string) => ({
  exitCode,
  imageTag: opts.tag,
  imageId: 'sha256:built',
  stdout: '',
  stderr: '',
  error,
  timedOut: false,
  durationMs: 1,
});
/** Emulates docker: a non-`--from` COPY source absent from the context dir fails the build. */
function dockerLike(envInspect: () => { exists: boolean; imageId: string | null }) {
  const images = new Set<string>([SANDBOX_CORE_IMAGE]);
  const seen: { dockerfile: string; context: string[] }[] = [];
  const build = vi.fn(async (opts: DockerBuildOpts) => {
    const dockerfile = await readFile(opts.dockerfilePath!, 'utf8');
    const context = await readdir(opts.contextDir);
    seen.push({ dockerfile, context });
    for (const line of dockerfile.split('\n')) {
      const m = /^COPY\s+(.+)$/.exec(line);
      if (!m || m[1]!.startsWith('--from')) continue;
      const parts = m[1]!.split(/\s+/).filter((p) => !p.startsWith('--'));
      for (const src of parts.slice(0, -1))
        if (!context.includes(src)) return result(opts, 1, `"/${src}": not found`);
    }
    images.add(opts.tag);
    return result(opts);
  });
  const inspect = vi.fn(async (ref: string) => {
    if (ref === ENV_TAG) return envInspect();
    if (ref === SANDBOX_CORE_IMAGE) return { exists: true, imageId: CORE_ID };
    return { exists: images.has(ref), imageId: images.has(ref) ? 'sha256:x' : null };
  });
  const remove = vi.fn(async (ref: string) => {
    images.delete(ref);
    return { ok: true, stderr: '' };
  });
  return { runner: fakeDockerRunner({ build, inspect, remove }), build, inspect, remove, seen };
}
const envOk =
  (id = ENV_ID) =>
  () => ({ exists: true, imageId: id });

beforeEach(() => {
  vi.mocked(ensureSandboxCoreImage).mockClear();
});

describe('C ensureComposedImage builds from the environment image', () => {
  it('builds once FROM the env tag with only the Dockerfile and the git MCP install files', async () => {
    const { runner, build, seen } = dockerLike(envOk());
    const tag = await ensureComposedImage(database(), 't', provider, runner);
    expect(tag).toMatch(/^haive-sandbox:[0-9a-f]{16}$/);
    expect(build).toHaveBeenCalledTimes(1);
    expect(seen[0]!.dockerfile.startsWith(`FROM ${ENV_TAG}\n`)).toBe(true);
    expect(seen[0]!.dockerfile).not.toContain('composer.json');
    expect(seen[0]!.context).toEqual([
      'Dockerfile',
      'git-mcp-requirements.txt',
      'install-git-mcp.sh',
    ]);
  });
});

describe('D environment image identity', () => {
  it('a changed env image id yields a different tag', async () => {
    const a = dockerLike(envOk('sha256:envid1'));
    const b = dockerLike(envOk('sha256:envid2'));
    const tagA = await ensureComposedImage(
      database({ imageTag: ENV_TAG, builtImageId: 'sha256:envid1' }),
      't',
      provider,
      a.runner,
    );
    const tagB = await ensureComposedImage(
      database({ imageTag: ENV_TAG, builtImageId: 'sha256:envid2' }),
      't',
      provider,
      b.runner,
    );
    expect(tagA).not.toBe(tagB);
  });
  it.each([
    [
      'env image missing',
      () => ({ exists: false, imageId: null }),
      { imageTag: ENV_TAG, builtImageId: ENV_ID },
    ],
    ['imageTag null', envOk(), { imageTag: null, builtImageId: ENV_ID }],
    ['builtImageId mismatch', envOk(), { imageTag: ENV_TAG, builtImageId: 'sha256:other' }],
  ])(
    '%s rejects with ComposedImageNotVerifiedError and builds nothing',
    async (_l, inspect, env) => {
      const { runner, build } = dockerLike(inspect);
      await expect(
        ensureComposedImage(database(env), 't', provider, runner),
      ).rejects.toBeInstanceOf(ComposedImageNotVerifiedError);
      expect(build).not.toHaveBeenCalled();
      expect(ensureSandboxCoreImage).not.toHaveBeenCalled();
    },
  );
  it('an env id that changes between resolve and build rejects without building', async () => {
    let calls = 0;
    const { runner, build } = dockerLike(() => ({
      exists: true,
      imageId: ++calls === 1 ? ENV_ID : 'sha256:envid2',
    }));
    await expect(ensureComposedImage(database(), 't', provider, runner)).rejects.toBeInstanceOf(
      ComposedImageNotVerifiedError,
    );
    expect(build).not.toHaveBeenCalled();
  });
  it('an env id that moves during the build removes the built tag and rejects', async () => {
    let built = false;
    const docker = dockerLike(() => ({ exists: true, imageId: built ? 'sha256:envid2' : ENV_ID }));
    docker.build.mockImplementationOnce(async (opts: DockerBuildOpts) => {
      built = true;
      return result(opts);
    });
    await expect(
      ensureComposedImage(database(), 't', provider, docker.runner),
    ).rejects.toBeInstanceOf(ComposedImageNotVerifiedError);
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(docker.remove).toHaveBeenCalledWith(
      expect.stringMatching(/^haive-sandbox:[0-9a-f]{16}$/),
      {
        force: true,
      },
    );
  });
});

describe('E withResolvedComposedImage never builds a contract-2 pasted body', () => {
  it('rejects a miss without environmentImage and does not build', async () => {
    const c = compose(contract2);
    const composition = {
      ...c,
      installContract: 2,
      inputs: { rtkVersion: '0.42.4', baseImageId: CORE_ID, rtkPin: '0.42.4', requestedHash: 'x' },
    } as ResolvedSandboxImageComposition;
    const build = vi.fn(async (opts: DockerBuildOpts) => result(opts));
    const runner = fakeDockerRunner({
      build,
      inspect: async () => ({ exists: false, imageId: null }),
    });
    await expect(
      withResolvedComposedImage(composition, async (x) => x.tag, runner),
    ).rejects.toThrow();
    expect(build).not.toHaveBeenCalled();
  });
});

describe('F a pinned launch does not depend on the environment image', () => {
  const effectiveTag = 'haive-sandbox:pinnedtag';
  const refs = {
    schemaVersion: 1,
    entries: [
      {
        providerId: provider.id,
        effective: {
          tag: effectiveTag,
          imageId: 'sha256:pinned',
          identityHash: 'verified',
          inputs: {
            rtkVersion: '0.42.4',
            rtkPin: '0.42.4',
            baseImageId: CORE_ID,
            requestedHash: composedRequestedInputsHash(body, provider, deps),
          },
        },
      },
    ],
  };
  it.each([
    ['missing', { imageTag: null, builtImageId: null }],
    ['changed', { imageTag: ENV_TAG, builtImageId: 'sha256:changed' }],
  ])('returns the pinned image id with the env image %s', async (_l, env) => {
    const inspect = vi.fn(async (ref: string) => {
      if (ref === effectiveTag) return { exists: true, imageId: 'sha256:pinned' };
      throw new Error(`unexpected inspect of ${ref}`);
    });
    const runner = fakeDockerRunner({ inspect });
    const db = database(env, { composedLspImageRefs: refs });
    expect(await resolveSandboxImageTag(db, 't', provider, runner)).toBe('sha256:pinned');
    expect(inspect.mock.calls.map((c) => c[0])).not.toContain(ENV_TAG);
  });
});

describe('G loadComposedLspIdentity', () => {
  it('returns null when the env image is missing', async () => {
    const { runner } = dockerLike(() => ({ exists: false, imageId: null }));
    expect(await loadComposedLspIdentity(database(), 't', provider.id, runner)).toBeNull();
  });
  it('reports the env image id and the environment-based composition tag', async () => {
    const runner = fakeDockerRunner({
      inspect: async (ref) => ({
        exists: true,
        imageId:
          ref === ENV_TAG ? ENV_ID : ref === SANDBOX_CORE_IMAGE ? CORE_ID : 'sha256:composed',
      }),
    });
    const identity = await loadComposedLspIdentity(database(), 't', provider.id, runner);
    expect(identity?.environmentImageId).toBe(ENV_ID);
    const expectedTag = compose({
      ...contract2,
      environmentImage: { ref: ENV_TAG, imageId: ENV_ID },
    }).tag;
    expect(identity?.tag).toBe(expectedTag);
    expect(identity?.tag).not.toBe(compose(contract2).tag);
  });
});
