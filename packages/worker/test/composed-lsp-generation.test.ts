import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { FormValues } from '@haive/shared';
import { assertKnownLspInstallContract } from '../src/sandbox/lsp-install-contract.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import {
  envTemplateHash,
  generateDockerfileStep,
  renderDockerfile,
} from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import type { GenerateDockerfileDetect } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';

const hashOverride = vi.hoisted(() => ({ known: null as string | null }));

vi.mock('../src/step-engine/steps/env-replicate/_shared.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/step-engine/steps/env-replicate/_shared.js')>();
  return {
    ...actual,
    findEnvTemplateByHash: (...args: Parameters<typeof actual.findEnvTemplateByHash>) =>
      hashOverride.known === null
        ? actual.findEnvTemplateByHash(...args)
        : Promise.resolve(args[2] === hashOverride.known ? ({ id: 'tpl-legacy' } as never) : null),
  };
});

beforeEach(() => {
  hashOverride.known = null;
});

const MARKER = '# Language servers';

function withoutLspBlock(body: string): string {
  const lines = body.split('\n');
  const start = lines.indexOf(MARKER);
  const end = lines.indexOf('', start);
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

describe('assertKnownLspInstallContract', () => {
  it.each([undefined, 1, 2])('accepts %j', (version) => {
    expect(() =>
      assertKnownLspInstallContract({ lspInstallContractVersion: version }),
    ).not.toThrow();
  });

  it.each([null, 0, 3, '1', '2', {}])('refuses %j', (version) => {
    expect(() => assertKnownLspInstallContract({ lspInstallContractVersion: version })).toThrow(
      /Unsupported LSP install contract/,
    );
  });
});

describe('renderDockerfile under contract 2', () => {
  it('omits the language server installer for 2 and keeps it for 1', () => {
    const deps = { lspServers: ['intelephense'] };
    const two = renderDockerfile('ubuntu:24.04', { ...deps, lspInstallContractVersion: 2 });
    expect(two).not.toContain(MARKER);
    expect(two).not.toContain('npm install -g intelephense');
    const one = renderDockerfile('ubuntu:24.04', { ...deps, lspInstallContractVersion: 1 });
    expect(one).toContain(MARKER);
    expect(one).toContain('npm install -g intelephense');
  });

  it('differs from the contract 1 render only by the language server block', () => {
    const deps = {
      lspServers: ['intelephense', 'vtsls', 'gopls'],
      runtimes: ['php', 'node', 'go'],
    };
    const one = renderDockerfile('ubuntu:24.04', { ...deps, lspInstallContractVersion: 1 });
    const two = renderDockerfile('ubuntu:24.04', { ...deps, lspInstallContractVersion: 2 });
    expect(one).toContain(MARKER);
    expect(two).toBe(withoutLspBlock(one));
  });

  it('renders an absent key and key 1 identically, both with the block', () => {
    const deps = { lspServers: ['intelephense', 'gopls'], runtimes: ['php', 'go'] };
    const absent = renderDockerfile('ubuntu:24.04', deps);
    expect(renderDockerfile('ubuntu:24.04', { ...deps, lspInstallContractVersion: 1 })).toBe(
      absent,
    );
    expect(absent).toContain(MARKER);
  });
});

function detectCtx(declaredDeps: unknown): StepContext {
  return {
    taskId: 'task',
    db: {
      query: {
        tasks: { findFirst: async () => ({ envTemplateId: 'env' }) },
        envTemplates: {
          findFirst: async () => ({
            baseImage: 'ubuntu:24.04',
            declaredDeps,
            generatedDockerfile: 'FROM ubuntu:24.04\nRUN echo custom\n',
          }),
        },
      },
    },
  } as unknown as StepContext;
}

describe('02 detect under contract 2', () => {
  it('returns the saved body for a row carrying 2', async () => {
    const out = await generateDockerfileStep.detect!(detectCtx({ lspInstallContractVersion: 2 }));
    expect(out.currentDockerfile).toBe('FROM ubuntu:24.04\nRUN echo custom\n');
  });

  it.each([3, 0, '1', null])('refuses a row carrying %j', async (version) => {
    await expect(
      generateDockerfileStep.detect!(detectCtx({ lspInstallContractVersion: version })),
    ).rejects.toThrow(/Unsupported LSP install contract/);
  });
});

const DOCKERFILE = 'FROM ubuntu:24.04\nRUN echo hi\n';

function applyHarness(rowDeps: unknown, rowExists = true) {
  const calls = { find: 0, update: 0, delete: 0, link: 0 };
  const db = {
    query: {
      envTemplates: {
        findFirst: vi.fn(async () => {
          calls.find += 1;
          return calls.find === 1 && rowExists ? { declaredDeps: rowDeps } : undefined;
        }),
      },
    },
    select: () => ({ from: () => ({ where: async () => [] }) }),
    update: () => ({
      set: () => ({
        where: async () => {
          calls.update += 1;
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        calls.delete += 1;
      },
    }),
  } as unknown as Database;
  const ctx = {
    taskId: 'task-1',
    userId: 'user-1',
    db,
    logger: { info: () => undefined },
  } as unknown as StepContext;
  return { ctx, calls };
}

function runApply(ctx: StepContext, declaredDeps: Record<string, unknown>) {
  const detected: GenerateDockerfileDetect = {
    envTemplateId: 'tpl-current',
    baseImage: 'ubuntu:24.04',
    declaredDeps,
    currentDockerfile: DOCKERFILE,
  };
  return generateDockerfileStep.apply(ctx, {
    detected,
    formValues: { dockerfile: DOCKERFILE } as FormValues,
  } as Parameters<typeof generateDockerfileStep.apply>[1]);
}

describe('02 apply LSP owner guard', () => {
  it.each([
    ['detected without key, row with 2', {}, { lspInstallContractVersion: 2 }],
    ['detected with 2, row without key', { lspInstallContractVersion: 2 }, {}],
    [
      'detected with 1, row with 2',
      { lspInstallContractVersion: 1 },
      { lspInstallContractVersion: 2 },
    ],
  ])('refuses and writes nothing: %s', async (_name, detectedDeps, rowDeps) => {
    const { ctx, calls } = applyHarness(rowDeps);
    await expect(runApply(ctx, detectedDeps)).rejects.toThrow(/LSP install owner changed/);
    expect(calls).toEqual({ find: 1, update: 0, delete: 0, link: 0 });
  });

  it('saves when detected 2 and row 2 agree', async () => {
    const deps = { lspInstallContractVersion: 2 };
    const { ctx, calls } = applyHarness(deps);
    await expect(runApply(ctx, deps)).resolves.toMatchObject({ envTemplateId: 'tpl-current' });
    expect(calls.update).toBe(1);
  });

  it('saves when neither side carries the key', async () => {
    const { ctx, calls } = applyHarness({});
    await expect(runApply(ctx, {})).resolves.toMatchObject({ envTemplateId: 'tpl-current' });
    expect(calls.update).toBe(1);
    const missing = applyHarness(undefined, false);
    await expect(runApply(missing.ctx, {})).resolves.toMatchObject({
      envTemplateId: 'tpl-current',
    });
    expect(missing.calls.update).toBe(1);
  });
});

describe('envTemplateHash and the contract key', () => {
  it('separates absent, 1 and 2', () => {
    const hashes = [{}, { lspInstallContractVersion: 1 }, { lspInstallContractVersion: 2 }].map(
      (deps) => envTemplateHash(DOCKERFILE, deps),
    );
    expect(new Set(hashes).size).toBe(3);
  });
});

describe('reconcile identity under contract 2', () => {
  const LEGACY_BODY = 'FROM ubuntu:24.04\nRUN echo legacy';
  const FRESH = 'FROM ubuntu:24.04\nRUN echo fresh\n';
  const legacyDeps = { lspServers: ['gopls'] };

  function reconcile(declaredDeps: Record<string, unknown>) {
    hashOverride.known = envTemplateHash(LEGACY_BODY, legacyDeps);
    const detected: GenerateDockerfileDetect = {
      envTemplateId: 'tpl-new',
      baseImage: 'ubuntu:24.04',
      declaredDeps,
      currentDockerfile: FRESH,
    };
    const ctx = {
      userId: 'user-1',
      db: {},
      logger: { info: () => undefined },
    } as unknown as StepContext;
    return generateDockerfileStep.reconcileReusedFormValues!(ctx, detected, {
      dockerfile: LEGACY_BODY,
    } as FormValues);
  }

  it('drops a legacy body when this task carries 2', async () => {
    const out = await reconcile({ ...legacyDeps, lspInstallContractVersion: 2 });
    expect(out.dockerfile).toBe(FRESH);
  });

  it('keeps the legacy body under the legacy deps', async () => {
    const out = await reconcile(legacyDeps);
    expect(out.dockerfile).toBe(LEGACY_BODY);
  });
});
