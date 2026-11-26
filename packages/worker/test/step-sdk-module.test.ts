import { CODE_AUDIT_OUTPUT_CONTRACT, safeParseStepOutput } from '@haive/shared/step-outputs';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared/logger';
import type { Database } from '@haive/database';
import type { StepContext } from '@haive/shared/step';
import * as worker from '../src/step-engine/step-definition.js';
import { registerModuleSteps } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';

// This module has no composable steps; its registration never reads the built-in workflow catalogue.
vi.mock('../src/step-engine/steps/index.js', () => ({ emitsLoop: vi.fn() }));

const require = createRequire(import.meta.url);
let entries: typeof import('./fixtures/step-sdk/host.typecheck.js').entries;
let reviewWithHost: typeof import('./fixtures/step-sdk/src/steps.js').reviewWithHost;
let errors: typeof import('./fixtures/step-sdk/src/steps.js').errors;
let contractedAudit: typeof import('./fixtures/step-sdk/src/steps.js').contractedAudit;
let fixtureRoot: string | undefined;

beforeAll(async () => {
  // Build once outside the source tree, including when tests run as root in a container.
  fixtureRoot = mkdtempSync(join(tmpdir(), 'haive-step-sdk-'));
  copyFileSync(
    new URL('./fixtures/step-sdk/package.json', import.meta.url),
    join(fixtureRoot, 'package.json'),
  );
  // Resolve the host's existing peer installation, preserving the constructors' identity.
  symlinkSync(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(fixtureRoot, 'node_modules'),
  );
  execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '-p',
    fileURLToPath(new URL('./fixtures/step-sdk/tsconfig.json', import.meta.url)),
    '--outDir',
    join(fixtureRoot, 'dist'),
  ]);
  // Import through the copied package's self-reference and real runtime export conditions.
  const entryPath = join(fixtureRoot, 'entry.mjs');
  writeFileSync(
    entryPath,
    [
      "export { default as manifest } from '@haive/module-sdk-fixture/manifest';",
      "export { default, errors, reviewWithHost, contractedAudit } from '@haive/module-sdk-fixture/steps';",
    ].join('\n'),
  );
  const built = (await import(
    pathToFileURL(entryPath).href
  )) as typeof import('./fixtures/step-sdk/src/steps.js') & {
    manifest: typeof import('./fixtures/step-sdk/src/manifest.js').default;
  };
  entries = [
    { packageName: '@haive/module-sdk-fixture', manifest: built.manifest, steps: built.default },
  ];
  errors = built.errors;
  reviewWithHost = built.reviewWithHost;
  contractedAudit = built.contractedAudit;
}, 30_000);

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('compiled module step SDK consumer', () => {
  it('loads the static registry entry with namespacing and keeps the core step', () => {
    const registry = new StepRegistry();
    const [step] = entries[0].steps;
    registry.register(step);
    const [loaded] = registerModuleSteps(registry, entries);
    expect(loaded?.stepIds).toEqual(['module.sdk-fixture.report']);
    expect(registry.get('report')).toBe(step);
    expect(registry.require('module.sdk-fixture.report').attachmentContext).toBe('none');
    expect(registry.require('module.sdk-fixture.report').metadata).toMatchObject({
      id: 'module.sdk-fixture.report',
      workflowType: 'module.sdk-fixture',
    });
    expect(() => registerModuleSteps(registry, entries)).toThrow('already registered');
  });

  it('consumes the immutable host contract and inferred output through compiled package exports', async () => {
    expect(contractedAudit.outputContract).toBe(CODE_AUDIT_OUTPUT_CONTRACT);
    expect(Object.isFrozen(contractedAudit.outputContract)).toBe(true);
    const output = await contractedAudit.apply();
    expect(safeParseStepOutput(contractedAudit.outputContract, output)).toEqual({
      success: true,
      data: output,
    });
  });

  it('resolves all ten constructors to the worker objects through the compiled module', () => {
    expect(Object.keys(errors)).toHaveLength(10);
    expect(errors).toHaveProperty('StepPrepareDeferredError', worker.StepPrepareDeferredError);
    for (const name of Object.keys(errors) as (keyof typeof errors)[]) {
      expect(errors[name]).toBe(worker[name]);
    }
  });

  it('calls host services including typed role reads through the compiled public-only fixture', async () => {
    const host = {
      loadFixLoopDiagnosis: vi.fn(async () => null),
      loadRoleOutput: vi.fn(async () => ({
        state: 'absent' as const,
        role: 'haive.spec.checked',
        contract: { id: 'haive.spec.checked', version: 1 },
        producer: null,
      })),
      loadUnactedInsights: vi.fn(async () => ({ insights: [], omitted: 0 })),
      loadPreviousStepOutput: vi.fn(async () => ({
        detect: null,
        output: { worktreePath: '/fixture/tree' },
        iterations: [],
      })),
      collectImplementationFiles: vi.fn(async () => ({ files: ['a'], total: 1, truncated: false })),
      readReviewDiff: vi.fn(async () => ({
        status: 'unavailable' as const,
        partial: true as const,
        reason: 'fixture',
        scope: { files: [], total: 0, truncated: false },
      })),
    };
    const ctx: StepContext = {
      taskId: 'fixture-task',
      taskStepId: 'fixture-step',
      userId: 'fixture-user',
      repoPath: '/fixture',
      workspacePath: '/fixture',
      sandboxWorkdir: '/workspace',
      cliProviderId: null,
      round: 0,
      db: {} as Database,
      logger: logger.child({ test: 'sdk-host' }),
      signal: new AbortController().signal,
      throwIfCancelled() {},
      async emitProgress() {},
      host,
    };
    const result = await reviewWithHost(ctx);
    expect(result.role).toMatchObject({ state: 'absent', role: 'haive.spec.checked' });
    expect(host.loadRoleOutput).toHaveBeenCalledWith('spec');
    expect(result.inventory).toEqual({ insights: [], omitted: 0 });
    expect(host.loadUnactedInsights).toHaveBeenCalledWith({ includePicked: true });
    expect(host.loadPreviousStepOutput).toHaveBeenCalledWith('01-worktree-setup');
    expect(host.collectImplementationFiles).toHaveBeenCalledWith('/fixture/tree');
    expect(host.readReviewDiff).toHaveBeenCalledWith({
      worktreePath: '/fixture/tree',
      maxBytes: 4096,
      includeFileContents: true,
    });
    await expect(reviewWithHost({ ...ctx, host: undefined })).rejects.toThrow(
      'requires step host services',
    );
  });

  const signals = [
    ['cancel', 'TaskCancelledError'],
    ['advice', 'AdvisedStepError'],
    ['parse', 'RetryableParseError'],
    ['retry', 'MiningRetryError'],
    ['wave', 'MiningWaveError'],
    ['reopen', 'ReopenStepFormError'],
  ] as const;

  it.each(signals)('throws the canonical %s control from module apply', async (signal, name) => {
    const ctx = {
      taskId: 'fixture-task',
      taskStepId: 'fixture-step',
      userId: 'fixture-user',
      repoPath: '/fixture',
      workspacePath: '/fixture',
      sandboxWorkdir: '/workspace',
      cliProviderId: null,
      round: 0,
      db: {} as Database,
      logger: logger.child({ test: 'step-sdk' }),
      signal: new AbortController().signal,
      async emitProgress() {},
      throwIfCancelled() {},
    } satisfies StepContext;
    const [step] = entries[0].steps;
    await expect(
      step.apply(ctx, {
        detected: { path: 'src/example.ts' },
        formValues: { signal },
        iteration: 0,
        previousIterations: [],
      }),
    ).rejects.toBeInstanceOf(worker[name]);
  });
});
