import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { logger } from '@haive/shared/logger';
import type { Database } from '@haive/database';
import type { StepContext } from '@haive/shared/step';
import * as worker from '../src/step-engine/step-definition.js';
import { registerModuleSteps } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';

const require = createRequire(import.meta.url);
let entries: typeof import('./fixtures/step-sdk/host.typecheck.js').entries;
let errors: typeof import('./fixtures/step-sdk/dist/steps.js').errors;

beforeAll(async () => {
  // Build once through real package exports; this directory is outside the workspace package globs.
  execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '-p',
    fileURLToPath(new URL('./fixtures/step-sdk/tsconfig.json', import.meta.url)),
  ]);
  ({ entries } = await import('./fixtures/step-sdk/host.typecheck.js'));
  ({ errors } = await import('./fixtures/step-sdk/dist/steps.js'));
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
