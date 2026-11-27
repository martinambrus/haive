import { finishedStepResult } from '../src/step-engine/step-runner.js';
import { installPluginsStep } from '../src/step-engine/steps/workflow/01b-install-plugins.js';
import { createVerifyEnvironmentStep } from '../src/step-engine/steps/env-replicate/04-verify-environment.js';
import { updateOwnedStep } from '../src/step-engine/step-ownership.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
const pluginIo = vi.hoisted(() => ({ runtime: vi.fn(), run: vi.fn() }));
vi.mock('../src/queues/cli-exec-queue.js', () => ({
  loadProviderRuntimeConfig: pluginIo.runtime,
  resolveAuthMounts: async () => [],
  resolveInvocationRepoMount: async () => ({ repoMount: null, hasWorktree: false, hasRepo: false }),
}));
vi.mock('../src/sandbox/sandbox-runner.js', async (original) => ({
  ...(await original<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox: pluginIo.run,
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', () => ({ resolveSecretMasks: async () => [] }));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', () => ({
  repoGitDataBoundary: async () => ({ mounts: [], masks: [] }),
}));
vi.mock('../src/queues/cli-exec/haive-data-boundary.js', () => ({
  haiveDataBoundary: async () => [],
}));
vi.mock('../src/queues/cli-exec/worktrees-boundary.js', () => ({
  worktreesBoundary: async () => [],
}));
import * as lspLayer from '../src/sandbox/lsp-layer.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import type { CliProviderName } from '@haive/shared';
import { resolveImageTag } from '../src/sandbox/image-cache.js';
import { createFakeDb } from '@haive/database/testing';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resetStepAndDownstream } from '../src/queues/_step-reset.js';
import { retainedComposedImageRefs } from '../src/lsp/composed-evidence.js';
import { peekSandboxImageTag } from '../src/queues/cli-exec/images.js';
import { SANDBOX_CORE_IMAGE } from '../src/sandbox/image-composer.js';
import { logger } from '@haive/shared';
import { fakeDockerRunner } from './fake-docker-runner.js';
import { hasReadyLspBridge, readyComposedLspImage } from '../src/lsp/configured-lsp.js';
import {
  composedEntryMatches,
  evidenceHash,
  loadComposedLspIdentity,
  lspProviderIdentity,
  currentPhpPluginFilesHash,
  parseImageReferences,
  updateImageReferences,
  retainComposedImage,
  MAX_COMPOSED_LSP_PROVIDERS,
  MAX_COMPOSED_LSP_REPORTS,
  type ComposedLspEntry,
  type ComposedLspIdentity,
} from '../src/lsp/composed-evidence.js';
import {
  COMPOSED_PROBE_OUTPUT_MAX_CHARS,
  parseComposedProbeReport,
  probeComposedServer,
} from '../src/lsp/composed-probe.js';
import { createVerifyComposedLspStep } from '../src/step-engine/steps/workflow/01b1-verify-composed-lsp.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const phpFiles = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  readFileNoFollow: phpFiles.read,
}));
vi.mock('../src/repo/worktree-git-boundary.js', async (original) => ({
  ...(await original<typeof import('../src/repo/worktree-git-boundary.js')>()),
  resolveInvocationWorkerTree: async () => '/repo',
}));
vi.mock('../src/sandbox/sandbox-core-image.js', async (original) => ({
  ...(await original<object>()),
  ensureSandboxCoreImage: async () => {},
}));
const ids = {
  task: '11111111-1111-4111-8111-111111111111',
  env: '22222222-2222-4222-8222-222222222222',
  provider: '33333333-3333-4333-8333-333333333333',
  plugin: '44444444-4444-4444-8444-444444444444',
  verify: '55555555-5555-4555-8555-555555555555',
  bootstrap: '99999999-9999-4999-8999-999999999999',
};
const success = { exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 };
function probeResult(server = 'gopls') {
  return {
    ...success,
    stdout: JSON.stringify({
      server,
      passed: true,
      skipped: false,
      installedVersion: 'v0.18.0',
      toolchainVersion: 'go1.26.7',
    }),
  };
}
function fixture() {
  const f = createFakeDb({
    tasks: schema.tasks,
    envTemplates: schema.envTemplates,
    taskSteps: schema.taskSteps,
    cliProviders: schema.cliProviders,
    toolPackageVersions: schema.toolPackageVersions,
    repositories: schema.repositories,
    cliInvocations: schema.cliInvocations,
    taskStepAgentMinings: schema.taskStepAgentMinings,
    taskDagIssues: schema.taskDagIssues,
    taskDagPlans: schema.taskDagPlans,
  });
  f.insert(schema.tasks, {
    id: ids.task,
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    envTemplateId: ids.env,
    type: 'workflow',
    runListSnapshot: [
      '04-verify-environment',
      '01-worktree-setup',
      '01b-install-plugins',
      '01b1-verify-composed-lsp',
    ],
    executionPath: null,
    metadata: { feature: 'retain-me' },
    status: 'running',
    orchestrationEpoch: 3,
  });
  f.insert(schema.envTemplates, {
    id: ids.env,
    status: 'ready',
    imageTag: 'env:built',
    lastBuiltAt: new Date(0),
    generatedDockerfile: 'FROM ubuntu:24.04\n',
    declaredDeps: {
      lspInstallContractVersion: 2,
      lspServers: ['gopls'],
      lspServerVersions: { go: '0.18.0' },
    },
  });
  f.insert(schema.cliProviders, {
    id: ids.provider,
    name: 'claude-code',
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    enabled: true,
    cliVersion: '1.0.0',
    sandboxDockerfileExtra: null,
    envVars: null,
  });
  const provider = f.rows(schema.cliProviders)[0]!;
  f.insert(schema.taskSteps, {
    id: ids.plugin,
    taskId: ids.task,
    stepId: '01b-install-plugins',
    stepIndex: 10,
    runSeq: 10,
    round: 0,
    status: 'done',
    detectOutput: { providerName: 'claude-code', lspLanguages: ['go'] },
    output: {
      skipped: false,
      composedLspProviderHash: lspProviderIdentity(provider),
      executed: [{ exitCode: 0 }],
    },
  });
  f.insert(schema.taskSteps, {
    id: ids.verify,
    taskId: ids.task,
    stepId: '01b1-verify-composed-lsp',
    stepIndex: 1.21,
    runSeq: 11,
    round: 0,
    status: 'running',
    rerunGeneration: 0,
  });
  f.insert(schema.taskSteps, {
    id: ids.bootstrap,
    taskId: ids.task,
    stepId: '04-verify-environment',
    stepIndex: 4,
    runSeq: 4,
    round: 0,
    status: 'done',
    endedAt: new Date(50),
  });
  const db = f.db as unknown as Database;
  let image = 'sha256:verified';
  const run = vi.fn(async (opts: { cmd: string[] }) =>
    opts.cmd[0] === 'node' && opts.cmd[1] === '-e' ? probeResult(opts.cmd.at(-1)) : success,
  );
  const runner = fakeDockerRunner({
    inspect: async () => ({ exists: true, imageId: image }),
    run,
    build: async () => {
      throw new Error('unexpected build');
    },
  });
  const ctx = {
    taskId: ids.task,
    taskStepId: ids.verify,
    cliProviderId: ids.provider,
    db,
    logger,
    signal: new AbortController().signal,
    epoch: 3,
    rerunGeneration: 0,
  } as unknown as StepContext;
  const write = async (
    table:
      | typeof schema.tasks
      | typeof schema.taskSteps
      | typeof schema.cliProviders
      | typeof schema.envTemplates,
    id: string,
    values: Record<string, unknown>,
  ) => {
    await db.update(table).set(values).where(eq(table.id, id));
  };
  const identity = () => loadComposedLspIdentity(db, ids.task, ids.provider, runner);
  const installEvidence = async () => {
    const current = (await identity())!;
    const entry: ComposedLspEntry = {
      identity: current,
      outcome: 'verified',
      reports: [
        {
          server: 'gopls',
          passed: true,
          skipped: false,
          installedVersion: '0.18.0',
          toolchainVersion: 'go1.26.7',
          stdout: '',
          stderr: '',
        },
      ],
    };
    const refs = updateImageReferences(
      parseImageReferences(null),
      ids.provider,
      {
        tag: current.tag,
        imageId: current.imageId,
        identityHash: evidenceHash(current),
        inputs: current.inputs,
      },
      true,
    );
    await write(schema.tasks, ids.task, {
      metadata: { feature: 'retain-me', composedLspImageRefs: refs },
    });
    await write(schema.taskSteps, ids.verify, {
      status: 'done',
      endedAt: new Date(100),
      output: {
        envTemplateId: ids.env,
        reports: [{ id: 'lsp-gopls', passed: true }],
        verification: { stepRowId: ids.verify, generation: 0, epoch: 3 },
        composedLsp: { schemaVersion: 1, entries: [entry] },
      },
    });
    return entry;
  };
  return {
    f,
    db,
    runner,
    run,
    ctx,
    write,
    identity,
    installEvidence,
    setImage: (value: string) => {
      image = value;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  phpFiles.read.mockImplementation(async () => ({ data: Buffer.from('{}'), truncated: false }));
});

it.each(['pending', 'skipped'] as const)(
  'without a retained image, bootstrap %s controls launch without claiming readiness',
  async (status) => {
    const f = fixture();
    await f.write(schema.taskSteps, ids.bootstrap, { status });
    const launch = () =>
      resolveSandboxImageTag(f.db, ids.task, f.f.rows(schema.cliProviders)[0] as never, f.runner);
    expect(
      await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
    ).toBe(false);
    // A skipped 04 keeps the provider-image fallback (owner-visible decision on T709 (h)):
    // Skip is explicit and readiness stays false, so LSP is never claimed.
    const row = f.f.rows(schema.cliProviders)[0] as typeof schema.cliProviders.$inferSelect;
    const providerTag = resolveImageTag({
      name: row.name as CliProviderName,
      cliVersion: row.cliVersion || null,
      providerId: row.id,
      sandboxDockerfileExtra: row.sandboxDockerfileExtra,
    })?.tag;
    // The provider image (with the CLI installed), never the bare sandbox core image.
    expect(providerTag).toBeTruthy();
    expect(await launch()).toBe(providerTag);
    expect(f.run).not.toHaveBeenCalled();
  },
);

it('an unready Go plugin gets language-neutral recovery guidance', async () => {
  const f = fixture();
  await f.write(schema.taskSteps, ids.plugin, { output: { skipped: true } });
  const step = createVerifyComposedLspStep(f.runner);
  const detected = await step.detect!(f.ctx);
  const result = await step.apply(f.ctx, {
    detected,
    formValues: {},
    iteration: 0,
    previousIterations: [],
  });
  expect(result.bridgeReady).toBe(false);
  expect(result.guidance).toMatch(/plugin.*Retry 01b/);
  expect(result.guidance).not.toContain('PHP');
});

describe('composed LSP identity and readiness', () => {
  it('requires only matching composed evidence, and pins its immutable image at execution', async () => {
    const f = fixture();
    await f.installEvidence();
    expect(
      await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
    ).toBe(true);
    expect(
      await readyComposedLspImage(f.db, ids.task, ids.provider, f.runner, 'sha256:verified'),
    ).toBe('sha256:verified');
    expect(
      await readyComposedLspImage(f.db, ids.task, ids.provider, f.runner, 'sha256:other'),
    ).toBeNull();
    await f.write(schema.taskSteps, ids.verify, {
      output: {
        verification: { stepRowId: ids.verify, generation: 0, epoch: 3 },
        composedLsp: { schemaVersion: 1, entries: [await f.installEvidence()] },
      },
    });
    expect(
      await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
    ).toBe(true);
    expect(
      await resolveSandboxImageTag(
        f.db,
        ids.task,
        f.f.rows(schema.cliProviders)[0] as never,
        f.runner,
      ),
    ).toBe('sha256:verified');
  });
  const mutations: Array<[string, (i: ComposedLspIdentity) => void]> = [
    [
      'schema',
      (i) => {
        i.schemaVersion = 2 as 1;
      },
    ],
    [
      'template',
      (i) => {
        i.envTemplateId = 'other';
      },
    ],
    [
      'contract',
      (i) => {
        i.installContract = 1 as 2;
      },
    ],
    [
      'body',
      (i) => {
        i.templateBodyHash = 'changed';
      },
    ],
    [
      'pin',
      (i) => {
        i.selection[0]!.version = '0.19.0';
      },
    ],
    [
      'recipe',
      (i) => {
        i.recipeHash = 'new';
      },
    ],
    [
      'provider id',
      (i) => {
        i.provider.id = 'other';
      },
    ],
    [
      'provider name',
      (i) => {
        i.provider.name = 'zai';
      },
    ],
    [
      'provider version',
      (i) => {
        i.provider.cliVersion = '2';
      },
    ],
    [
      'provider extras',
      (i) => {
        i.provider.extrasHash = 'new';
      },
    ],
    [
      'provider config',
      (i) => {
        i.provider.configHash = 'new';
      },
    ],
    [
      'plugin result',
      (i) => {
        i.plugin.hash = 'new';
      },
    ],
    [
      'plugin files',
      (i) => {
        i.plugin.filesHash = 'new';
      },
    ],
    [
      'plugin missing',
      (i) => {
        i.plugin.ready = false;
      },
    ],
    [
      'composition',
      (i) => {
        i.compositionHash = 'new';
      },
    ],
    [
      'tag',
      (i) => {
        i.tag = 'other';
      },
    ],
    [
      'image ID',
      (i) => {
        i.imageId = 'sha256:other';
      },
    ],
  ];
  it.each(mutations)('rejects mismatched %s at the pure unit layer', async (_label, mutate) => {
    const f = fixture();
    const entry = await f.installEvidence();
    const current = structuredClone(entry.identity);
    mutate(current);
    expect(composedEntryMatches(entry, current)).toBe(false);
  });
  it.each(['omit', 'skip', 'fail', 'version', 'duplicate', 'outcome', 'schema'] as const)(
    'rejects %s evidence',
    async (kind) => {
      const f = fixture();
      const entry = await f.installEvidence();
      if (kind === 'omit') entry.reports = [];
      if (kind === 'skip') entry.reports[0]!.skipped = true;
      if (kind === 'fail') entry.reports[0]!.passed = false;
      if (kind === 'version') entry.reports[0]!.installedVersion = null;
      if (kind === 'duplicate') entry.reports.push({ ...entry.reports[0]! });
      if (kind === 'outcome') entry.outcome = 'failed';
      const evidence = { schemaVersion: kind === 'schema' ? 2 : 1, entries: [entry] };
      await f.write(schema.taskSteps, ids.verify, {
        output: {
          envTemplateId: ids.env,
          reports: [{ id: 'lsp-gopls', passed: true }],
          verification: { stepRowId: ids.verify, generation: 0, epoch: 3 },
          composedLsp: evidence,
        },
      });
      expect(
        await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
      ).toBe(false);
    },
  );
  it.each([
    'provider',
    'pin',
    'body',
    'plugin',
    'image',
    'no row',
    'retry',
    'no template',
    'ruby',
    'unsupported CLI',
  ] as const)('rechecks changed %s at execution', async (kind) => {
    const f = fixture();
    await f.installEvidence();
    if (kind === 'provider')
      await f.write(schema.cliProviders, ids.provider, { envVars: { PATH: '/other' } });
    if (kind === 'pin')
      await f.write(schema.envTemplates, ids.env, {
        declaredDeps: {
          lspInstallContractVersion: 2,
          lspServers: ['gopls'],
          lspServerVersions: { go: '0.19.0' },
        },
      });
    if (kind === 'body')
      await f.write(schema.envTemplates, ids.env, {
        generatedDockerfile: 'FROM ubuntu:24.04\nRUN true',
      });
    if (kind === 'plugin')
      await f.write(schema.taskSteps, ids.plugin, { output: { skipped: true } });
    if (kind === 'image') f.setImage('sha256:new');
    if (kind === 'no row')
      await f.db.delete(schema.taskSteps).where(eq(schema.taskSteps.id, ids.verify));
    if (kind === 'retry')
      await resetStepAndDownstream(f.db, ids.task, '04-verify-environment', 0, 3);
    if (kind === 'no template') await f.write(schema.tasks, ids.task, { envTemplateId: null });
    if (kind === 'ruby')
      await f.write(schema.envTemplates, ids.env, {
        declaredDeps: { lspInstallContractVersion: 2, lspServers: ['solargraph'] },
      });
    if (kind === 'unsupported CLI')
      await f.write(schema.cliProviders, ids.provider, { name: 'codex' });
    expect(
      await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
    ).toBe(false);
  });
});

describe('per-run final checks and retained ownership', () => {
  it('checks the exact composed ID as node without overriding the image PATH and rewrites the full current entry', async () => {
    const f = fixture();
    await f.write(schema.envTemplates, ids.env, {
      declaredDeps: {
        ...(f.f.rows(schema.envTemplates)[0]!.declaredDeps as object),
        runtimes: ['node', 'python'],
      },
    });
    const step = createVerifyComposedLspStep(f.runner);
    const detected = await step.detect!(f.ctx);
    const result = await step.apply(f.ctx, {
      detected,
      formValues: { selectedChecks: ['bash'] },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.reports).toEqual([]);
    expect(result.environmentReports?.map((r) => r.id)).toEqual(['node', 'python', 'bash']);
    expect(result.verification).toEqual({ stepRowId: ids.verify, generation: 0, epoch: 3 });
    expect(result.composedLsp?.entries).toHaveLength(1);
    expect(result.composedLsp?.entries[0]?.outcome).toBe('verified');
    const probe = f.run.mock.calls.find(([opts]) => opts.cmd[1] === '-e')?.[0];
    expect(probe).toMatchObject({
      image: 'sha256:verified',
      user: 'node',
      entrypoint: '',
      network: 'none',
      pull: 'never',
    });
    expect(probe).not.toHaveProperty('env');
    const metadata = f.f.rows(schema.tasks)[0]!.metadata as Record<string, unknown>;
    expect(metadata.feature).toBe('retain-me');
    expect(parseImageReferences(metadata).entries[0]?.effective?.imageId).toBe('sha256:verified');
  });
  it('a failed replacement keeps prior effective reference and cannot label old pins as requested', async () => {
    const f = fixture();
    await f.installEvidence();
    await f.write(schema.taskSteps, ids.verify, { status: 'running' });
    const original = parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata).entries[0]!
      .effective;
    await f.write(schema.envTemplates, ids.env, {
      declaredDeps: {
        lspInstallContractVersion: 2,
        lspServers: ['gopls'],
        lspServerVersions: { go: '0.19.0' },
      },
    });
    f.run.mockImplementation(async () => ({ ...probeResult(), exitCode: 1 }));
    const step = createVerifyComposedLspStep(f.runner);
    const detected = await step.detect!(f.ctx);
    const result = await step.apply(f.ctx, {
      detected,
      formValues: { selectedChecks: ['bash'] },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.composedLsp?.entries[0]?.outcome).toBe('failed');
    expect(parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata).entries[0]!.effective).toEqual(
      original,
    );
    await expect(
      resolveSandboxImageTag(f.db, ids.task, f.f.rows(schema.cliProviders)[0] as never, f.runner),
    ).rejects.toThrow(/Requested composed image inputs changed/);
  });
  it('a Retry clears readiness but preserves effective/prior/verifying ownership', async () => {
    const f = fixture();
    const entry = await f.installEvidence();
    const refs = updateImageReferences(
      parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata),
      ids.provider,
      {
        tag: 'candidate:new',
        imageId: 'sha256:new',
        identityHash: 'new',
        inputs: entry.identity.inputs,
      },
      false,
    );
    await f.write(schema.tasks, ids.task, { metadata: { composedLspImageRefs: refs } });
    await resetStepAndDownstream(f.db, ids.task, '04-verify-environment', 0, 3);
    expect(
      await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
    ).toBe(false);
    const retained = parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata).entries[0]!;
    expect(retained.effective?.imageId).toBe(entry.identity.imageId);
    expect(retained.verifying?.imageId).toBe('sha256:new');
  });
  it.each(['generation', 'epoch', 'provider'] as const)(
    'refuses stale %s publication before touching the reference',
    async (kind) => {
      const f = fixture();
      const identity = (await f.identity())!;
      if (kind === 'generation')
        await f.write(schema.taskSteps, ids.verify, { rerunGeneration: 1 });
      if (kind === 'epoch') await f.write(schema.tasks, ids.task, { orchestrationEpoch: 4 });
      if (kind === 'provider')
        await f.write(schema.cliProviders, ids.provider, { cliVersion: '2.0.0' });
      await expect(
        retainComposedImage(
          f.db,
          ids.task,
          identity,
          true,
          { stepId: ids.verify, generation: 0, epoch: 3 },
          f.runner,
        ),
      ).rejects.toThrow(/superseded|inputs changed/);
      expect(parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata).entries).toEqual([]);
    },
  );
  it('bounds retained providers at an injectable small limit and pins production bounds', () => {
    expect(MAX_COMPOSED_LSP_PROVIDERS).toBe(16);
    expect(MAX_COMPOSED_LSP_REPORTS).toBe(7);
    const ref = {
      tag: 't',
      imageId: 'sha256:i',
      identityHash: 'h',
      inputs: { rtkVersion: '0.42.4', baseImageId: null, rtkPin: null, requestedHash: 'h' },
    };
    const refs = updateImageReferences(parseImageReferences(null), 'p', ref, true, 1);
    expect(() => updateImageReferences(refs, 'p2', ref, false, 1)).toThrow(/limit/);
    const replacement = updateImageReferences(
      refs,
      'p',
      { ...ref, imageId: 'sha256:new' },
      true,
      1,
    );
    expect(replacement.entries[0]?.prior).toEqual(ref);
  });
});

describe('bounded protocol reports', () => {
  it.each([
    'exit',
    'timeout',
    'error',
    'missing',
    'skipped',
    'wrong server',
    'version',
    'invalid JSON',
  ] as const)('cannot pass from %s', (kind) => {
    const result = probeResult();
    const raw = JSON.parse(result.stdout);
    if (kind === 'exit') result.exitCode = 1;
    if (kind === 'timeout') result.timedOut = true;
    if (kind === 'error') Object.assign(result, { error: 'failed' });
    if (kind === 'missing') delete raw.passed;
    if (kind === 'skipped') raw.skipped = true;
    if (kind === 'wrong server') raw.server = 'pyright';
    if (kind === 'version') raw.installedVersion = null;
    result.stdout = kind === 'invalid JSON' ? 'not json' : JSON.stringify(raw);
    expect(parseComposedProbeReport('gopls', result).passed).toBe(false);
  });
  it('caps captured report output', () => {
    expect(COMPOSED_PROBE_OUTPUT_MAX_CHARS).toBe(2000);
    expect(
      parseComposedProbeReport(
        'gopls',
        { ...success, stdout: 'x'.repeat(9), stderr: 'y'.repeat(9) },
        8,
      ),
    ).toMatchObject({ passed: false, stdout: 'x'.repeat(8), stderr: 'y'.repeat(8) });
    expect(
      parseComposedProbeReport(
        'gopls',
        { ...success, stdout: 'x'.repeat(8), stderr: 'y'.repeat(8) },
        8,
      ),
    ).toMatchObject({ stdout: 'x'.repeat(8), stderr: 'y'.repeat(8) });
  });
  it('uses the immutable image and a sandbox-user protocol check', async () => {
    const run = vi.fn(async (_opts: unknown) => probeResult());
    expect(
      (await probeComposedServer(fakeDockerRunner({ run }), 'sha256:test', 'gopls')).passed,
    ).toBe(true);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      image: 'sha256:test',
      user: 'node',
      entrypoint: '',
      pull: 'never',
    });
  });
});

describe('local PHP plugin files are part of current identity', () => {
  it('requires all plugin files and refuses missing, changed or truncated configuration', async () => {
    const f = fixture();
    const repo = '66666666-6666-4666-8666-666666666666';
    f.f.insert(schema.repositories, { id: repo, storagePath: '/repo' });
    await f.write(schema.tasks, ids.task, { repositoryId: repo });
    await f.write(schema.envTemplates, ids.env, {
      declaredDeps: { lspInstallContractVersion: 2, lspServers: ['intelephense'] },
    });
    await f.write(schema.taskSteps, ids.plugin, {
      detectOutput: { providerName: 'claude-code', lspLanguages: ['php'] },
    });
    const filesHash = await currentPhpPluginFilesHash(f.db, ids.task);
    const provider = f.f.rows(schema.cliProviders)[0]!;
    await f.write(schema.taskSteps, ids.plugin, {
      output: {
        skipped: false,
        composedLspProviderHash: lspProviderIdentity(provider),
        composedLspFilesHash: filesHash,
        executed: [{ exitCode: 0 }],
      },
    });
    expect((await f.identity())?.plugin.ready).toBe(true);
    phpFiles.read.mockResolvedValueOnce(null);
    expect((await f.identity())?.plugin.ready).toBe(false);
    phpFiles.read.mockResolvedValueOnce({ data: Buffer.from('changed'), truncated: false });
    expect((await f.identity())?.plugin.ready).toBe(false);
    phpFiles.read.mockResolvedValueOnce({ data: Buffer.from('{}'), truncated: true });
    expect((await f.identity())?.plugin.ready).toBe(false);
  });
});

it('rejects a verifier that claimed a plugin installed for another language covered this selection', async () => {
  const f = fixture();
  await f.write(schema.taskSteps, ids.plugin, {
    detectOutput: { providerName: 'claude-code', lspLanguages: ['typescript'] },
  });
  const entry = await f.installEvidence();
  // Simulate the old verifier's positive plugin claim, including a consistent
  // retained hash. Comparing opaque identity hashes alone used to accept this.
  entry.identity.plugin.ready = true;
  const refs = updateImageReferences(
    parseImageReferences(null),
    ids.provider,
    {
      tag: entry.identity.tag,
      imageId: entry.identity.imageId,
      identityHash: evidenceHash(entry.identity),
      inputs: entry.identity.inputs,
    },
    true,
  );
  await f.write(schema.tasks, ids.task, { metadata: { composedLspImageRefs: refs } });
  await f.write(schema.taskSteps, ids.verify, {
    output: {
      verification: { stepRowId: ids.verify, generation: 0, epoch: 3 },
      composedLsp: { schemaVersion: 1, entries: [entry] },
    },
  });
  expect(
    await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
  ).toBe(false);
});

it('a Retry of an older 04 row cannot reuse a completed higher-round row', async () => {
  const f = fixture();
  const entry = await f.installEvidence();
  f.f.insert(schema.taskSteps, {
    id: '77777777-7777-4777-8777-777777777777',
    taskId: ids.task,
    stepId: '04-verify-environment',
    round: 1,
    status: 'done',
    endedAt: new Date(200),
    output: { composedLsp: { schemaVersion: 1, entries: [entry] } },
  });
  await resetStepAndDownstream(f.db, ids.task, '04-verify-environment', 0, 3);
  expect(
    await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
  ).toBe(false);
});

describe('verified inputs stay pinned until requested inputs move', () => {
  it.each(['rtk cache', 'core image'] as const)(
    'launch, peek and readiness survive only a changed %s',
    async (kind) => {
      const f = fixture();
      const repo = '66666666-6666-4666-8666-666666666666';
      f.f.insert(schema.repositories, { id: repo, rtkVersion: null });
      await f.write(schema.tasks, ids.task, { repositoryId: repo });
      await f.write(schema.envTemplates, ids.env, {
        generatedDockerfile: `FROM ${SANDBOX_CORE_IMAGE}\n`,
      });
      f.f.insert(schema.toolPackageVersions, {
        name: 'rtk',
        versions: ['0.42.4'],
        latestVersion: '0.42.4',
      });
      const entry = await f.installEvidence();
      if (kind === 'rtk cache')
        await f.db
          .update(schema.toolPackageVersions)
          .set({ versions: ['0.43.0'], latestVersion: '0.43.0' })
          .where(eq(schema.toolPackageVersions.name, 'rtk'));
      else
        f.runner.inspect = async (tag) => ({
          exists: true,
          imageId: tag === SANDBOX_CORE_IMAGE ? 'sha256:new-core' : 'sha256:verified',
        });
      const provider = f.f.rows(schema.cliProviders)[0] as never;
      expect(await resolveSandboxImageTag(f.db, ids.task, provider, f.runner)).toBe(
        entry.identity.imageId,
      );
      expect(await peekSandboxImageTag(f.db, ids.task, provider, f.runner)).toEqual({
        tag: entry.identity.tag,
        imageId: entry.identity.imageId,
      });
      expect(
        await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
      ).toBe(true);
      expect(
        parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata).entries[0]!.effective,
      ).toMatchObject({
        inputs: { rtkVersion: '0.42.4', baseImageId: 'sha256:verified', rtkPin: null },
      });
    },
  );
  it.each(['body', 'name', 'cliVersion', 'extras'] as const)(
    'refuses launch when requested %s changes after verification',
    async (field) => {
      const f = fixture();
      await f.installEvidence();
      if (field === 'body')
        await f.write(schema.envTemplates, ids.env, {
          generatedDockerfile: 'FROM ubuntu:24.04\nRUN echo changed\n',
        });
      else
        await f.write(schema.cliProviders, ids.provider, {
          [field === 'extras' ? 'sandboxDockerfileExtra' : field]:
            field === 'name' ? 'zai' : field === 'cliVersion' ? '2.0.0' : 'RUN echo changed',
        });
      await expect(
        resolveSandboxImageTag(f.db, ids.task, f.f.rows(schema.cliProviders)[0] as never, f.runner),
      ).rejects.toThrow(/Requested composed image inputs changed/);
    },
  );
  it('rejects a newly requested repository RTK pin', async () => {
    const f = fixture();
    const repo = '66666666-6666-4666-8666-666666666666';
    f.f.insert(schema.repositories, { id: repo, rtkVersion: null });
    await f.write(schema.tasks, ids.task, { repositoryId: repo });
    await f.installEvidence();
    await f.db
      .update(schema.repositories)
      .set({ rtkVersion: '0.43.0' })
      .where(eq(schema.repositories.id, repo));
    await expect(
      resolveSandboxImageTag(f.db, ids.task, f.f.rows(schema.cliProviders)[0] as never, f.runner),
    ).rejects.toThrow(/requested.*RTK pin changed/i);
    expect(await readyComposedLspImage(f.db, ids.task, ids.provider, f.runner)).toBeNull();
  });
  it('does not prescribe Retry 04 when the verified image is missing', async () => {
    const f = fixture();
    await f.installEvidence();
    f.runner.inspect = async () => ({ exists: false, imageId: null });
    await expect(
      resolveSandboxImageTag(f.db, ids.task, f.f.rows(schema.cliProviders)[0] as never, f.runner),
    ).rejects.toThrow(/verification after the plugin result/);
  });
});

describe('provider identity allow-list', () => {
  it.each([
    'modelLimits',
    'modelProvisionStatus',
    'modelProvisionError',
    'rulesContent',
    'authGeneration',
  ])('ignores %s and preserves plugin/effective identity', async (field) => {
    const f = fixture();
    const before = await f.installEvidence();
    const provider = f.f.rows(schema.cliProviders)[0]!;
    expect(lspProviderIdentity({ ...provider, [field]: 'changed' })).toBe(
      lspProviderIdentity(provider),
    );
    await f.write(schema.cliProviders, ids.provider, {
      [field]: field === 'modelLimits' ? { model: 'x', vision: false } : 'changed',
    });
    expect((await f.identity())?.plugin.ready).toBe(true);
    expect(await readyComposedLspImage(f.db, ids.task, ids.provider, f.runner)).toBe(
      before.identity.imageId,
    );
  });
  it.each([
    'name',
    'cliVersion',
    'sandboxDockerfileExtra',
    'wrapperContent',
    'envVars',
    'cliArgs',
    'executablePath',
    'wrapperPath',
    'authMode',
    'isolateAuth',
  ])('binds %s', (field) => {
    expect(lspProviderIdentity({ [field]: 'before' })).not.toBe(
      lspProviderIdentity({ [field]: 'after' }),
    );
  });
});

it.each(['completed', 'cancelled', 'failed'] as const)(
  'releases only terminal tasks and retains every image role for %s',
  async (status) => {
    const f = fixture();
    const entry = await f.installEvidence();
    const ref = {
      tag: entry.identity.tag,
      imageId: entry.identity.imageId,
      identityHash: evidenceHash(entry.identity),
      inputs: entry.identity.inputs,
    };
    let refs = updateImageReferences(
      parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata),
      ids.provider,
      { ...ref, tag: 'effective:next', imageId: 'sha256:next' },
      true,
    );
    refs = updateImageReferences(
      refs,
      ids.provider,
      { ...ref, tag: 'verifying:candidate', imageId: 'sha256:candidate' },
      false,
    );
    await f.write(schema.tasks, ids.task, { metadata: { composedLspImageRefs: refs } });
    const allRoles = new Set([
      ref.tag,
      ref.imageId,
      'effective:next',
      'sha256:next',
      'verifying:candidate',
      'sha256:candidate',
    ]);
    expect(await retainedComposedImageRefs(retentionDb(f))).toEqual(allRoles);
    await f.write(schema.tasks, ids.task, { status });
    expect(await retainedComposedImageRefs(retentionDb(f))).toEqual(
      status === 'failed' ? allRoles : new Set(),
    );
  },
);

it.each(['04-verify-environment', '03-build-image'])(
  'real Retry of %s clears 04 and downstream plugin evidence while retaining all image roles',
  async (target) => {
    const f = fixture();
    const entry = await f.installEvidence();
    const ref = {
      tag: entry.identity.tag,
      imageId: entry.identity.imageId,
      identityHash: evidenceHash(entry.identity),
      inputs: entry.identity.inputs,
    };
    let refs = updateImageReferences(
      parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata),
      ids.provider,
      { ...ref, imageId: 'sha256:next' },
      true,
    );
    refs = updateImageReferences(
      refs,
      ids.provider,
      { ...ref, imageId: 'sha256:candidate' },
      false,
    );
    await f.write(schema.tasks, ids.task, {
      metadata: { feature: 'retain-me', composedLspImageRefs: refs },
    });
    f.f.insert(schema.taskSteps, {
      id: '88888888-8888-4888-8888-888888888888',
      taskId: ids.task,
      stepId: '03-build-image',
      status: 'done',
      round: 0,
      stepIndex: 3,
      runSeq: 3,
    });
    expect(await resetStepAndDownstream(f.db, ids.task, target, 0, 3)).toMatchObject({
      newEpoch: 4,
    });
    expect(f.f.rows(schema.taskSteps).find((s) => s.id === ids.verify)).toMatchObject({
      status: 'pending',
      output: null,
      endedAt: null,
    });
    expect(f.f.rows(schema.taskSteps).find((s) => s.id === ids.plugin)).toMatchObject({
      status: 'pending',
      output: null,
    });
    expect(f.f.rows(schema.tasks)[0]!.metadata).toEqual({
      feature: 'retain-me',
      composedLspImageRefs: refs,
    });
    expect(await retainedComposedImageRefs(retentionDb(f))).toEqual(
      new Set([ref.tag, ref.imageId, 'sha256:next', 'sha256:candidate']),
    );
    expect(await readyComposedLspImage(f.db, ids.task, ids.provider, f.runner)).toBeNull();
  },
);

function retentionDb(f: ReturnType<typeof fixture>): Database {
  return {
    select: () => ({
      from: () => ({
        where: async (where: SQL) => {
          const q = new PgDialect().sqlToQuery(where);
          const excluded = q.sql.includes('not in')
            ? q.params.filter((x) => ['completed', 'failed', 'cancelled'].includes(String(x)))
            : [];
          return f.f
            .rows(schema.tasks)
            .filter((t) => !excluded.includes(t.status))
            .map((t) => ({ metadata: t.metadata }));
        },
      }),
    }),
  } as unknown as Database;
}

it('keeps launch pinned across a worker recipe update while readiness requires fresh evidence', async () => {
  const f = fixture();
  const entry = await f.installEvidence();
  const original = lspLayer.buildLspLayer;
  const changed = vi
    .spyOn(lspLayer, 'buildLspLayer')
    .mockImplementation((...args) => original(...args) + '\n# worker recipe changed');
  try {
    expect(
      await resolveSandboxImageTag(
        f.db,
        ids.task,
        f.f.rows(schema.cliProviders)[0] as never,
        f.runner,
      ),
    ).toBe(entry.identity.imageId);
    expect(await readyComposedLspImage(f.db, ids.task, ids.provider, f.runner)).toBeNull();
  } finally {
    changed.mockRestore();
  }
});

it('launch stays pinned while the unchanged environment template is rebuilding', async () => {
  const f = fixture();
  const entry = await f.installEvidence();
  await f.write(schema.envTemplates, ids.env, { status: 'building' });
  const provider = f.f.rows(schema.cliProviders)[0] as never;
  expect(await resolveSandboxImageTag(f.db, ids.task, provider, f.runner)).toBe(
    entry.identity.imageId,
  );
  expect(await peekSandboxImageTag(f.db, ids.task, provider, f.runner)).toEqual({
    tag: entry.identity.tag,
    imageId: entry.identity.imageId,
  });
  expect(
    await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
  ).toBe(false);
});

/** The real bootstrap/plugin/final applies, with Docker and mounts replaced at
 * their existing seams. Done writes use the runner's real ownership helper. */
function lifecycle() {
  const f = fixture();
  const worktree = f.f.insert(schema.taskSteps, {
    taskId: ids.task,
    stepId: '01-worktree-setup',
    status: 'done',
    round: 0,
    stepIndex: 101,
    runSeq: 8,
    output: { worktreePath: '/repo' },
  });
  const ordered: string[] = [];
  const row = (id: string) =>
    f.f.rows(schema.taskSteps).find((s) => s.id === id)! as typeof schema.taskSteps.$inferSelect;
  const context = (id: string): StepContext => ({
    ...f.ctx,
    taskStepId: id,
    round: 0,
    epoch: f.f.rows(schema.tasks)[0]!.orchestrationEpoch as number,
    rerunGeneration: row(id).rerunGeneration,
    emitProgress: async () => {},
  });
  pluginIo.runtime.mockImplementation(async () => ({
    sandboxImage: await resolveSandboxImageTag(
      f.db,
      ids.task,
      f.f.rows(schema.cliProviders)[0] as never,
      f.runner,
    ),
    egressDomains: [],
  }));
  pluginIo.run.mockImplementation(async (spec, options) =>
    f.runner.run({ image: options.image, cmd: [spec.command, ...spec.args] }),
  );
  const execute = async <D, O>(id: string, step: StepDefinition<D, O>, complete = true) => {
    await f.write(schema.taskSteps, id, { status: 'running' });
    const ctx = context(id);
    const detected = await step.detect!(ctx);
    await updateOwnedStep(f.db, id, { detectOutput: detected as never }, ctx.rerunGeneration);
    ordered.push(row(id).stepId);
    const output = await step.apply(ctx, {
      detected,
      formValues: { selectedChecks: ['bash'] },
      iteration: 0,
      previousIterations: [],
    });
    if (complete)
      await updateOwnedStep(
        f.db,
        id,
        {
          status: 'done',
          endedAt: new Date(),
          output: output as never,
        },
        ctx.rerunGeneration,
      );
    return output;
  };
  const bootstrap = () => execute(ids.bootstrap, createVerifyEnvironmentStep(f.runner));
  const plugin = () => execute(ids.plugin, installPluginsStep);
  const final = (complete = true) =>
    execute(ids.verify, createVerifyComposedLspStep(f.runner), complete);
  const ready = () => readyComposedLspImage(f.db, ids.task, ids.provider, f.runner);
  const reset = (id: string, recovery = false) =>
    resetStepAndDownstream(
      f.db,
      ids.task,
      id,
      0,
      f.f.rows(schema.tasks)[0]!.orchestrationEpoch as number,
      recovery,
    );
  const pending = () =>
    f.f
      .rows(schema.taskSteps)
      .filter((s) => s.status === 'pending')
      .sort((a, b) => Number(a.runSeq) - Number(b.runSeq))
      .map((s) => s.stepId);
  const firstRun = async () => {
    await f.write(schema.taskSteps, ids.plugin, {
      status: 'pending',
      output: null,
      detectOutput: null,
    });
    const boot = await bootstrap();
    expect(boot.composedLsp?.entries[0]?.identity.plugin.ready).toBe(false);
    expect(await ready()).toBeNull();
    // 01b resolves the bootstrap's retained immutable image, even while tools
    // are unready. The production plugin apply actually executes both commands.
    const install = await plugin();
    expect(install.skipped).toBe(false);
    expect(install.executed.length).toBeGreaterThan(0);
    expect(pluginIo.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ image: 'sha256:verified' }),
    );
    expect(await ready()).toBeNull();
    const bootOutput = structuredClone(row(ids.bootstrap).output);
    expect((await final()).bridgeReady).toBe(true);
    expect(await ready()).toBe('sha256:verified');
    expect(row(ids.bootstrap).output).toEqual(bootOutput);
  };
  return {
    ...f,
    worktree,
    ordered,
    context,
    execute,
    bootstrap,
    plugin,
    final,
    ready,
    reset,
    pending,
    row,
    firstRun,
  };
}

it('keeps readiness null when a stale pass lands its done write through the unguarded production path', async () => {
  const f = lifecycle();
  await f.firstRun();
  const stale = structuredClone(f.row(ids.verify).output);
  const staleGeneration = f.row(ids.verify).rerunGeneration;
  await f.reset('01b1-verify-composed-lsp');
  // The retry's own pass owns the row again; the old pass is still in flight.
  await f.write(schema.taskSteps, ids.verify, { status: 'running' });
  expect(f.row(ids.verify).rerunGeneration).not.toBe(staleGeneration);
  // No expectedGeneration, as in step-runner's done write.
  await updateOwnedStep(f.db, ids.verify, {
    status: 'done',
    endedAt: new Date(),
    output: stale as never,
  });
  expect(f.row(ids.verify).status).toBe('done');
  expect(await f.ready()).toBeNull();
});

it.each(['04-verify-environment', '01b-install-plugins', '01b1-verify-composed-lsp'])(
  'recovers the actual ordered pipeline after Retry %s',
  async (target) => {
    const f = lifecycle();
    await f.firstRun();
    expect(f.ordered).toEqual([
      '04-verify-environment',
      '01b-install-plugins',
      '01b1-verify-composed-lsp',
    ]);
    const refs = structuredClone(f.f.rows(schema.tasks)[0]!.metadata);
    const originalPlugin = structuredClone(f.row(ids.plugin));
    await f.reset(target);
    expect(f.pending()).toEqual(
      target === '04-verify-environment'
        ? [
            '04-verify-environment',
            '01-worktree-setup',
            '01b-install-plugins',
            '01b1-verify-composed-lsp',
          ]
        : target === '01b-install-plugins'
          ? ['01b-install-plugins', '01b1-verify-composed-lsp']
          : ['01b1-verify-composed-lsp'],
    );
    expect(f.f.rows(schema.tasks)[0]!.metadata).toEqual(refs);
    expect(await f.ready()).toBeNull();
    f.ordered.length = 0;
    const installs = pluginIo.run.mock.calls.length;
    if (target === '04-verify-environment') {
      await f.bootstrap();
      // The normal forward walk runs worktree setup again before 01b.
      await f.write(schema.taskSteps, String(f.worktree.id), { status: 'done' });
    }
    if (target !== '01b1-verify-composed-lsp') await f.plugin();
    else expect(f.row(ids.plugin)).toEqual(originalPlugin);
    expect((await f.final()).bridgeReady).toBe(true);
    expect(await f.ready()).toBe('sha256:verified');
    expect(f.ordered).toEqual(
      target === '04-verify-environment'
        ? ['04-verify-environment', '01b-install-plugins', '01b1-verify-composed-lsp']
        : target === '01b-install-plugins'
          ? ['01b-install-plugins', '01b1-verify-composed-lsp']
          : ['01b1-verify-composed-lsp'],
    );
    if (target === '01b1-verify-composed-lsp')
      expect(pluginIo.run.mock.calls).toHaveLength(installs);
  },
);

it('a published reference before a lost done write stays unready; boot recovery repeats checks without a new generation', async () => {
  const f = lifecycle();
  await f.firstRun();
  await f.reset('01b1-verify-composed-lsp');
  const generation = f.row(ids.verify).rerunGeneration;
  const output = await f.final(false);
  expect(output.bridgeReady).toBe(true);
  expect(await f.ready()).toBeNull();
  const refs = structuredClone(f.f.rows(schema.tasks)[0]!.metadata);
  await f.reset('01b1-verify-composed-lsp', true);
  expect(f.row(ids.verify).rerunGeneration).toBe(generation);
  expect(f.f.rows(schema.tasks)[0]!.metadata).toEqual(refs);
  expect((await f.final()).bridgeReady).toBe(true);
  const calls = f.run.mock.calls.length;
  // A completed row with a lost forward handoff already has usable evidence;
  // its ordinary finished-row redelivery needs no new plugin installation.
  expect(await f.ready()).toBe('sha256:verified');
  expect(
    await finishedStepResult(
      f.db,
      ids.task,
      createVerifyComposedLspStep(f.runner),
      f.row(ids.verify),
    ),
  ).toMatchObject({ status: 'done', output: f.row(ids.verify).output });
  expect(f.run.mock.calls).toHaveLength(calls);
});

it.each(['generation', 'epoch'])(
  'a concurrent %s reset during final probes refuses publication under the final step fence',
  async (kind) => {
    const f = lifecycle();
    await f.firstRun();
    await f.reset('01b1-verify-composed-lsp');
    const before = parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata).entries[0]!.effective;
    let overtaken = false;
    f.run.mockImplementation(async (options) => {
      if (!overtaken && options.cmd[1] === '-e') {
        overtaken = true;
        if (kind === 'generation') await f.reset('01b1-verify-composed-lsp');
        else await f.write(schema.tasks, ids.task, { orchestrationEpoch: 20 });
      }
      return options.cmd[1] === '-e' ? probeResult() : success;
    });
    await expect(f.final()).rejects.toThrow(/superseded/);
    expect(parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata).entries[0]!.effective).toEqual(
      before,
    );
    expect(await f.ready()).toBeNull();
  },
);

it('repairs a disappeared composed image with final verification, but a missing environment requires Retry 03', async () => {
  const f = lifecycle();
  await f.firstRun();
  await f.reset('01b1-verify-composed-lsp');
  let missingComposed = true;
  f.runner.inspect = async (tag) => ({
    exists: !(missingComposed && tag.startsWith('haive-sandbox:')),
    imageId: missingComposed && tag.startsWith('haive-sandbox:') ? null : 'sha256:verified',
  });
  const build = vi.fn(async () => {
    missingComposed = false;
    return { ...success, imageTag: 'rebuilt', imageId: 'sha256:verified' };
  });
  f.runner.build = build;
  expect((await f.final()).bridgeReady).toBe(true);
  expect(build).toHaveBeenCalledOnce();
  expect(await f.ready()).toBe('sha256:verified');
  // A completed final row is not readiness once its composed image is gone again.
  missingComposed = true;
  expect(await f.ready()).toBeNull();
  await f.reset('01b1-verify-composed-lsp');
  const refs = structuredClone(f.f.rows(schema.tasks)[0]!.metadata);
  f.runner.inspect = async (tag) => ({
    exists: tag !== 'env:built',
    imageId: tag === 'env:built' ? null : 'sha256:verified',
  });
  await expect(f.final()).rejects.toThrow(/Environment image disappeared; Retry 03/);
  expect(f.f.rows(schema.tasks)[0]!.metadata).toEqual(refs);
  expect(await f.ready()).toBeNull();
});

it('a missing/skipped PHP plugin completes final checks with upgrade/01b guidance and no bridge claim', async () => {
  const f = lifecycle();
  await f.write(schema.envTemplates, ids.env, {
    declaredDeps: { lspInstallContractVersion: 2, lspServers: ['intelephense'] },
  });
  await f.write(schema.taskSteps, ids.plugin, {
    status: 'done',
    output: { skipped: true, missingDrupalLsp: '.claude/plugins/drupal-php-lsp' },
  });
  const result = await f.final();
  expect(result.bridgeReady).toBe(false);
  expect(result.guidance).toMatch(/Upgrade.*Retry 01b/);
  expect(await f.ready()).toBeNull();
});

it.each([undefined, 1])(
  'legacy contract %s skips the final step with no form or Docker calls',
  async (contract) => {
    const f = fixture();
    await f.write(schema.envTemplates, ids.env, {
      declaredDeps: {
        ...(contract === undefined ? {} : { lspInstallContractVersion: contract }),
        lspServers: ['gopls'],
      },
    });
    const step = createVerifyComposedLspStep(f.runner);
    expect(await step.shouldRun!(f.ctx)).toBe(false);
    expect(step.form).toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
  },
);

it.each([
  '04-verify-environment',
  '01-worktree-setup',
  '01b-install-plugins',
  '01b1-verify-composed-lsp',
])('final verification refuses a frozen list missing %s before probing', async (missing) => {
  const f = fixture();
  const snapshot = [
    '04-verify-environment',
    '01-worktree-setup',
    '01b-install-plugins',
    '01b1-verify-composed-lsp',
  ].filter((id) => id !== missing);
  await f.write(schema.tasks, ids.task, { runListSnapshot: snapshot });
  const step = createVerifyComposedLspStep(f.runner);
  await expect(step.detect!(f.ctx)).rejects.toThrow(/effective run list/);
  expect(f.f.rows(schema.tasks)[0]!.runListSnapshot).toEqual(snapshot);
  expect(f.run).not.toHaveBeenCalled();
});
