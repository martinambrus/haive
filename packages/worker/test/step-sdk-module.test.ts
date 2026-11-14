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
let errors: typeof import('./fixtures/step-sdk/src/steps.js').errors;
let fixtureRoot: string | undefined;

beforeAll(async () => {
  // Build once outside the source tree, including when tests run as root in a container.
  fixtureRoot = mkdtempSync(join(tmpdir(), 'haive-step-sdk-'));
  copyFileSync(
    new URL('./fixtures/step-sdk/package.json', import.meta.url),
    join(fixtureRoot, 'package.json'),
  );
  // Resolve the host's existing peer installation, preserving the six constructors' identity.
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
      "export { default, errors } from '@haive/module-sdk-fixture/steps';",
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
    expect(registry.require('module.sdk-fixture.report').metadata).toMatchObject({
      id: 'module.sdk-fixture.report',
      workflowType: 'module.sdk-fixture',
    });
    expect(() => registerModuleSteps(registry, entries)).toThrow('already registered');
  });

  it('resolves all seven constructors to the worker objects through the compiled module', () => {
    for (const name of Object.keys(errors) as (keyof typeof errors)[]) {
      expect(errors[name]).toBe(worker[name]);
    }
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
