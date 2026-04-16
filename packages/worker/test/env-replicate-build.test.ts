import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { createBuildImageStep } from '../src/step-engine/steps/env-replicate/03-build-image.js';
import {
  buildSmokeChecks,
  createVerifyEnvironmentStep,
  type SmokeCheck,
} from '../src/step-engine/steps/env-replicate/04-verify-environment.js';
import type { DockerBuildOpts, DockerRunner } from '../src/sandbox/docker-runner.js';

function makeStubCtx(): { ctx: StepContext; updates: Record<string, unknown>[] } {
  const updates: Record<string, unknown>[] = [];
  const db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
        },
      }),
    }),
  } as unknown as Database;
  return {
    ctx: {
      taskId: '11111111-2222-3333-4444-555555555555',
      taskStepId: 'step-1',
      userId: 'user-1',
      repoPath: '/tmp/repo',
      workspacePath: '/tmp/repo',
      cliProviderId: null,
      db,
      logger: logger.child({ test: 'env-replicate-build' }),
      emitProgress: async () => {},
    },
    updates,
  };
}

describe('createBuildImageStep.apply', () => {
  it('skips build when image exists and forceRebuild is false', async () => {
    const stubRunner: DockerRunner = {
      build: async () => {
        throw new Error('runner.build should not be called on skip');
      },
      run: async () => {
        throw new Error('runner.run should not be called');
      },
    };
    const step = createBuildImageStep(stubRunner);
    const { ctx, updates } = makeStubCtx();
    const result = await step.apply(ctx, {
      detected: {
        envTemplateId: 'env-1',
        name: 'task-abcdef01',
        baseImage: 'ubuntu:24.04',
        dockerfile: 'FROM ubuntu:24.04\n',
        currentImageId: 'sha256:abc',
        status: 'ready',
      },
      formValues: { imageTag: 'haive-env-test:latest', forceRebuild: false },
    });
    expect(result.skipped).toBe(true);
    expect(result.imageId).toBe('sha256:abc');
    expect(updates).toEqual([]);
  });

  it('builds the image and updates status to ready on success', async () => {
    const calls: DockerBuildOpts[] = [];
    const stubRunner: DockerRunner = {
      build: async (opts) => {
        calls.push(opts);
        const contents = await readFile(opts.dockerfilePath!, 'utf8');
        expect(contents).toContain('FROM ubuntu:24.04');
        return {
          exitCode: 0,
          imageTag: opts.tag,
          imageId: 'sha256:xyz',
          durationMs: 123,
          stderr: '',
          timedOut: false,
        };
      },
      run: async () => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
      }),
    };
    const step = createBuildImageStep(stubRunner);
    const { ctx, updates } = makeStubCtx();
    const result = await step.apply(ctx, {
      detected: {
        envTemplateId: 'env-2',
        name: 'task-deadbeef',
        baseImage: 'ubuntu:24.04',
        dockerfile: 'FROM ubuntu:24.04\nRUN echo hello\n',
        currentImageId: null,
        status: 'pending',
      },
      formValues: { imageTag: 'haive-env-foo:latest', forceRebuild: true },
    });
    expect(result.skipped).toBe(false);
    expect(result.imageId).toBe('sha256:xyz');
    expect(result.imageTag).toBe('haive-env-foo:latest');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.tag).toBe('haive-env-foo:latest');
    expect(updates).toHaveLength(2);
    expect(updates[0]!.status).toBe('building');
    expect(updates[1]!.status).toBe('ready');
    expect(updates[1]!.builtImageId).toBe('sha256:xyz');
  });

  it('throws and marks status failed when build exits non-zero', async () => {
    const stubRunner: DockerRunner = {
      build: async () => ({
        exitCode: 1,
        imageTag: 'haive-env:bad',
        imageId: null,
        durationMs: 50,
        stderr: 'build failed: package not found',
        timedOut: false,
      }),
      run: async () => {
        throw new Error('no');
      },
    };
    const step = createBuildImageStep(stubRunner);
    const { ctx, updates } = makeStubCtx();
    await expect(
      step.apply(ctx, {
        detected: {
          envTemplateId: 'env-3',
          name: 'task-abc12345',
          baseImage: 'ubuntu:24.04',
          dockerfile: 'FROM ubuntu:24.04\n',
          currentImageId: null,
          status: 'pending',
        },
        formValues: { imageTag: 'haive-env:bad', forceRebuild: true },
      }),
    ).rejects.toThrow(/docker build failed with exit 1/);
    expect(updates).toHaveLength(2);
    expect(updates[0]!.status).toBe('building');
    expect(updates[1]!.status).toBe('failed');
  });
});

describe('buildSmokeChecks', () => {
  it('produces checks for each declared runtime plus a shell probe', () => {
    const checks = buildSmokeChecks({ runtimes: ['node', 'php'] });
    const ids = checks.map((c) => c.id);
    expect(ids).toContain('node');
    expect(ids).toContain('php');
    expect(ids).toContain('bash');
  });

  it('adds a postgres client check when database.kind is postgres', () => {
    const checks = buildSmokeChecks({ database: { kind: 'postgres' } });
    const pg = checks.find((c) => c.id === 'db-postgres');
    expect(pg?.cmd).toEqual(['psql', '--version']);
  });

  it('adds LSP server checks', () => {
    const checks = buildSmokeChecks({
      lspServers: ['intelephense', 'pyright'],
    });
    const ids = checks.map((c) => c.id);
    expect(ids).toContain('lsp-intelephense');
    expect(ids).toContain('lsp-pyright');
  });

  it('returns only the shell probe when nothing is declared', () => {
    const checks = buildSmokeChecks({});
    expect(checks.map((c) => c.id)).toEqual(['bash']);
  });
});

describe('createVerifyEnvironmentStep.apply', () => {
  it('runs each selected check and splits into passed and failed', async () => {
    const calls: string[] = [];
    const stubRunner: DockerRunner = {
      build: async () => {
        throw new Error('no');
      },
      run: async (opts) => {
        calls.push(opts.cmd[0] ?? '');
        const first = opts.cmd[0] ?? '';
        const pass = first === 'node';
        return {
          exitCode: pass ? 0 : 1,
          stdout: pass ? 'v22.0.0' : '',
          stderr: pass ? '' : 'command not found',
          durationMs: 10,
          timedOut: false,
        };
      },
    };
    const step = createVerifyEnvironmentStep(stubRunner);
    const { ctx } = makeStubCtx();
    const checks: SmokeCheck[] = [
      { id: 'node', label: 'Node', cmd: ['node', '--version'] },
      { id: 'php', label: 'PHP', cmd: ['php', '--version'] },
    ];
    const result = await step.apply(ctx, {
      detected: {
        envTemplateId: 'env-9',
        imageRef: 'haive-env-foo:latest',
        checks,
      },
      formValues: { selectedChecks: ['node', 'php'] },
    });
    expect(calls).toEqual(['node', 'php']);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.reports).toHaveLength(2);
    expect(result.reports[0]!.passed).toBe(true);
    expect(result.reports[1]!.passed).toBe(false);
  });

  it('skips checks that are not in selectedChecks', async () => {
    const calls: string[] = [];
    const stubRunner: DockerRunner = {
      build: async () => {
        throw new Error('no');
      },
      run: async (opts) => {
        calls.push(opts.cmd[0] ?? '');
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
        };
      },
    };
    const step = createVerifyEnvironmentStep(stubRunner);
    const { ctx } = makeStubCtx();
    const checks: SmokeCheck[] = [
      { id: 'node', label: 'Node', cmd: ['node', '--version'] },
      { id: 'php', label: 'PHP', cmd: ['php', '--version'] },
      { id: 'bash', label: 'Shell', cmd: ['bash', '-c', 'echo ok'] },
    ];
    const result = await step.apply(ctx, {
      detected: {
        envTemplateId: 'env-10',
        imageRef: 'haive-env-foo:latest',
        checks,
      },
      formValues: { selectedChecks: ['node', 'bash'] },
    });
    expect(calls).toEqual(['node', 'bash']);
    expect(result.reports).toHaveLength(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});
