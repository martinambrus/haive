import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { ComposedImageNotVerifiedError } from '../src/lsp/composed-image-refs.js';
import { peekSandboxImageTag, resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { composeSandboxImage, SANDBOX_CORE_IMAGE } from '../src/sandbox/image-composer.js';
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
const legacyProvider = {
  name: 'claude-code' as const,
  cliVersion: '1.2.3',
  sandboxDockerfileExtra: null,
};
const COPY_LINE = 'COPY composer.json composer.lock ./';
const copyBody = `FROM node:22\nWORKDIR /app\n${COPY_LINE}\nRUN composer install\n`;
const plainBody = 'FROM node:22\nWORKDIR /app\nRUN echo hi\n';
const ENV_TAG = 'haive-env-task-1a2b3c4d:latest';
const ENV_ID = `sha256:${'a1'.repeat(32)}`;
const OTHER_ID = `sha256:${'b2'.repeat(32)}`;
const CORE_ID = 'sha256:core';
const env = { ref: ENV_TAG, imageId: ENV_ID };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LEGACY_DEPS = [{}, { lspInstallContractVersion: 1 }];
const compose = (extra: Record<string, unknown> = {}, envBody: string | null = copyBody) =>
  composeSandboxImage({
    envTemplateDockerfile: envBody,
    provider: legacyProvider,
    rtkVersion: '0.42.4',
    ...extra,
  });

describe('composer: a legacy composition builds FROM the environment image', () => {
  it.each([undefined, 1])('contract %s starts FROM the ref and pastes nothing', (contract) => {
    const c = compose({
      lspInstallContractVersion: contract,
      environmentImage: env,
      lspServers: ['php-extended'],
    });
    expect(
      c.dockerfileBody.startsWith(`FROM ${ENV_TAG}\n# haive-environment-image: ${ENV_ID}\n`),
    ).toBe(true);
    expect(c.dockerfileBody).not.toContain(COPY_LINE);
    expect(c.dockerfileBody).not.toContain('FROM node:22');
    expect(c.dockerfileBody).not.toContain('# haive-lsp-install-contract: 2');
    expect(c.dockerfileBody).not.toContain('haive-lsp');
  });
  it('the image id decides the tag', () => {
    const a = compose({ environmentImage: env });
    expect(compose({ environmentImage: { ref: ENV_TAG, imageId: OTHER_ID } }).tag).not.toBe(a.tag);
    expect(compose({ environmentImage: { ...env } }).tag).toBe(a.tag);
  });
  it('the core image id does not move a composition built on its environment image', () => {
    const coreBody = `FROM ${SANDBOX_CORE_IMAGE}\nRUN echo x\n`;
    const tag = (extra: Record<string, unknown>) => compose(extra, coreBody).tag;
    expect(tag({ environmentImage: env, baseImageId: 'sha256:a' })).toBe(
      tag({ environmentImage: env, baseImageId: 'sha256:b' }),
    );
    expect(tag({ baseImageId: 'sha256:a' })).not.toBe(tag({ baseImageId: 'sha256:b' }));
  });
  it.each([
    ['ref newline', { ref: 'a\nRUN x', imageId: ENV_ID }],
    ['ref space', { ref: 'a b', imageId: ENV_ID }],
    ['imageId newline', { ref: ENV_TAG, imageId: 'sha256:a\nRUN x' }],
    ['imageId space', { ref: ENV_TAG, imageId: 'sha256:a b' }],
  ])('still throws on %s', (_label, bad) => {
    expect(() => compose({ environmentImage: bad })).toThrow(Error);
  });
  it.each([
    ['the default tag shape', ENV_TAG],
    ['a registry tag', 'localhost:5000/team/env.name_x:v1.2-rc'],
  ])('accepts %s and a sha256 id', (_label, ref) => {
    expect(() => compose({ environmentImage: { ref, imageId: ENV_ID } })).not.toThrow();
  });
});

describe('goldens that stay byte-identical', () => {
  it('contract 2 with an environment image', () => {
    const c = compose(
      {
        lspInstallContractVersion: 2,
        lspServers: ['php-extended'],
        lspServerVersions: { php: '1.18.4' },
        environmentImage: { ref: 'haive-env:abc123', imageId: 'sha256:envid1' },
      },
      copyBody,
    );
    expect(c.tag).toBe('haive-sandbox:ee0f9802e3b7c479');
    expect(sha(c.dockerfileBody)).toBe(
      'ee0f9802e3b7c479d1e3560d51536e03d9e9ae2f0047c4cf1e4e60e090f38ddd',
    );
  });
  it('contract 2 without an environment image', () => {
    const c = compose({
      lspInstallContractVersion: 2,
      lspServers: ['php-extended'],
      lspServerVersions: { php: '1.18.4' },
    });
    expect(c.tag).toBe('haive-sandbox:19e600548bec9184');
  });
  it('no environment template', () => {
    const c = composeSandboxImage({ envTemplateDockerfile: null, provider: legacyProvider });
    expect(c.tag).toBe('haive-sandbox:83c5089a241f3504');
    expect(c.dockerfileBody.startsWith(`FROM ${SANDBOX_CORE_IMAGE}`)).toBe(true);
  });
  it('legacy without an environment image', () => {
    expect(compose().tag).toBe('haive-sandbox:b413570a412022a8');
    expect(compose({ lspInstallContractVersion: 1 }).tag).toBe('haive-sandbox:b413570a412022a8');
  });
});

interface EnvRow {
  imageTag: string | null;
  builtImageId: string | null;
}
function database(declaredDeps: unknown, envBody: string, row: EnvRow) {
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
const okRow: EnvRow = { imageTag: ENV_TAG, builtImageId: ENV_ID };
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
function dockerLike(
  envInspect: () => { exists: boolean; imageId: string | null },
  built: string[] = [],
) {
  const images = new Set<string>([SANDBOX_CORE_IMAGE, ...built]);
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

describe('launch: a legacy row builds on its environment image', () => {
  it.each(LEGACY_DEPS)('declaredDeps %j builds once FROM the ref', async (declared) => {
    const { runner, build, seen } = dockerLike(envOk());
    const tag = await resolveSandboxImageTag(
      database(declared, copyBody, okRow),
      't',
      provider,
      runner,
    );
    expect(tag).toMatch(/^haive-sandbox:[0-9a-f]{16}$/);
    expect(build).toHaveBeenCalledTimes(1);
    expect(seen[0]!.dockerfile.startsWith(`FROM ${ENV_TAG}\n`)).toBe(true);
    expect(seen[0]!.dockerfile).not.toContain(COPY_LINE);
    expect(seen[0]!.context).toEqual([
      'Dockerfile',
      'git-mcp-requirements.txt',
      'install-git-mcp.sh',
    ]);
    expect(
      await resolveSandboxImageTag(database(declared, copyBody, okRow), 't', provider, runner),
    ).toBe(tag);
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('launch: a legacy row without a usable environment image pastes its body', () => {
  const bodyTag = () =>
    composeSandboxImage({
      envTemplateDockerfile: plainBody,
      provider: legacyProvider,
      rtkVersion: '0.42.4',
      baseImageId: CORE_ID,
    }).tag;
  it.each([
    ['imageTag null', envOk(), { imageTag: null, builtImageId: ENV_ID }],
    ['env image missing', () => ({ exists: false, imageId: null }), okRow],
    ['builtImageId differs', envOk(), { imageTag: ENV_TAG, builtImageId: OTHER_ID }],
    ['builtImageId is the tag string', envOk(), { imageTag: ENV_TAG, builtImageId: ENV_TAG }],
  ])('%s', async (_l, inspect, row) => {
    const { runner, build, seen } = dockerLike(inspect);
    const tag = await resolveSandboxImageTag(database({}, plainBody, row), 't', provider, runner);
    expect(tag).toBe(bodyTag());
    expect(build).toHaveBeenCalledTimes(1);
    expect(seen[0]!.dockerfile).toContain(plainBody.trimEnd());
    expect(seen[0]!.dockerfile).not.toContain('haive-environment-image');
  });
  it('a stored builtImageId of null with the image present is used', async () => {
    const { runner, seen } = dockerLike(envOk());
    const tag = await resolveSandboxImageTag(
      database({}, plainBody, { imageTag: ENV_TAG, builtImageId: null }),
      't',
      provider,
      runner,
    );
    expect(tag).not.toBe(bodyTag());
    expect(seen[0]!.dockerfile.startsWith(`FROM ${ENV_TAG}\n`)).toBe(true);
  });
});

describe('launch: guards for a legacy composition', () => {
  it('an env id that changes between resolve and build rejects without building', async () => {
    let calls = 0;
    const { runner, build } = dockerLike(() => ({
      exists: true,
      imageId: ++calls === 1 ? ENV_ID : OTHER_ID,
    }));
    const run = resolveSandboxImageTag(database({}, copyBody, okRow), 't', provider, runner);
    await expect(run).rejects.toBeInstanceOf(ComposedImageNotVerifiedError);
    expect(build).not.toHaveBeenCalled();
  });
  it('an env id that moves during the build removes the built tag and rejects', async () => {
    let built = false;
    const docker = dockerLike(() => ({ exists: true, imageId: built ? OTHER_ID : ENV_ID }));
    docker.build.mockImplementationOnce(async (opts: DockerBuildOpts) => {
      built = true;
      return result(opts);
    });
    const run = resolveSandboxImageTag(database({}, copyBody, okRow), 't', provider, docker.runner);
    await expect(run).rejects.toBeInstanceOf(ComposedImageNotVerifiedError);
    expect(docker.build).toHaveBeenCalledTimes(1);
    expect(docker.remove).toHaveBeenCalledWith(
      expect.stringMatching(/^haive-sandbox:[0-9a-f]{16}$/),
      {
        force: true,
      },
    );
  });
});

describe('peek: a legacy row looks for the environment-based tag', () => {
  it('returns the tag and id when it is built', async () => {
    const envTag = compose({ environmentImage: env }).tag;
    expect(envTag).not.toBe(compose().tag);
    const { runner, build } = dockerLike(envOk(), [envTag]);
    expect(await peekSandboxImageTag(database({}, copyBody, okRow), 't', provider, runner)).toEqual(
      {
        tag: envTag,
        imageId: 'sha256:x',
      },
    );
    expect(build).not.toHaveBeenCalled();
    expect(ensureSandboxCoreImage).not.toHaveBeenCalled();
  });
  it('returns null when it is not built', async () => {
    const { runner, build } = dockerLike(envOk());
    expect(
      await peekSandboxImageTag(database({}, copyBody, okRow), 't', provider, runner),
    ).toBeNull();
    expect(build).not.toHaveBeenCalled();
    expect(ensureSandboxCoreImage).not.toHaveBeenCalled();
  });
});
