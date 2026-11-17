import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { eq } from 'drizzle-orm';
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
import { parseComposedProbeReport, probeComposedServer } from '../src/lsp/composed-probe.js';
import { createVerifyEnvironmentStep } from '../src/step-engine/steps/env-replicate/04-verify-environment.js';
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
vi.mock('../src/sandbox/sandbox-core-image.js', () => ({ ensureSandboxCoreImage: async () => {} }));
const ids = {
  task: '11111111-1111-4111-8111-111111111111',
  env: '22222222-2222-4222-8222-222222222222',
  provider: '33333333-3333-4333-8333-333333333333',
  plugin: '44444444-4444-4444-8444-444444444444',
  verify: '55555555-5555-4555-8555-555555555555',
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
  });
  f.insert(schema.tasks, {
    id: ids.task,
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    envTemplateId: ids.env,
    metadata: { feature: 'retain-me' },
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
  const provider = f.rows(schema.cliProviders)[0];
  f.insert(schema.taskSteps, {
    id: ids.plugin,
    taskId: ids.task,
    stepId: '01b-install-plugins',
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
    stepId: '04-verify-environment',
    round: 0,
    status: 'running',
    rerunGeneration: 0,
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
      { tag: current.tag, imageId: current.imageId, identityHash: evidenceHash(current) },
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
      output: { composedLsp: { schemaVersion: 1, entries: [await f.installEvidence()] } },
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
      await f.write(schema.taskSteps, ids.verify, {
        status: 'pending',
        output: null,
        endedAt: null,
      });
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

describe('per-run 04 checks and retained ownership', () => {
  it('checks the exact composed ID as node without overriding the image PATH and rewrites the full current entry', async () => {
    const f = fixture();
    const step = createVerifyEnvironmentStep(f.runner);
    const detected = await step.detect(f.ctx);
    const result = await step.apply(f.ctx, {
      detected,
      formValues: { selectedChecks: ['bash'] },
      iteration: 0,
      previousIterations: [],
    });
    expect(result.reports).toEqual([]);
    expect(result.environmentReports?.map((r) => r.id)).toEqual(['bash']);
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
    const step = createVerifyEnvironmentStep(f.runner);
    const detected = await step.detect(f.ctx);
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
    ).rejects.toThrow(/has not passed 04/);
  });
  it('a Retry clears readiness but preserves effective/prior/verifying ownership', async () => {
    const f = fixture();
    const entry = await f.installEvidence();
    const refs = updateImageReferences(
      parseImageReferences(f.f.rows(schema.tasks)[0]!.metadata),
      ids.provider,
      { tag: 'candidate:new', imageId: 'sha256:new', identityHash: 'new' },
      false,
    );
    await f.write(schema.tasks, ids.task, { metadata: { composedLspImageRefs: refs } });
    await f.write(schema.taskSteps, ids.verify, { status: 'pending', output: null, endedAt: null });
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
    const ref = { tag: 't', imageId: 'sha256:i', identityHash: 'h' };
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
    expect(
      parseComposedProbeReport('gopls', {
        ...success,
        stdout: 'x'.repeat(2200),
        stderr: 'y'.repeat(2200),
      }),
    ).toMatchObject({ passed: false, stdout: 'x'.repeat(2000), stderr: 'y'.repeat(2000) });
  });
  it('uses the immutable image and a sandbox-user protocol check', async () => {
    const run = vi.fn(async () => probeResult());
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
    },
    true,
  );
  await f.write(schema.tasks, ids.task, { metadata: { composedLspImageRefs: refs } });
  await f.write(schema.taskSteps, ids.verify, {
    output: { composedLsp: { schemaVersion: 1, entries: [entry] } },
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
  await f.write(schema.taskSteps, ids.verify, { status: 'pending', output: null, endedAt: null });
  expect(
    await hasReadyLspBridge(f.db, ids.task, { providerId: ids.provider, runner: f.runner }),
  ).toBe(false);
});
