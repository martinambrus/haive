import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  execFile: vi.fn(),
  getTaskEnvTemplate: vi.fn(),
  resolveDdevWorkspace: vi.fn(),
  loadPreviousStepOutput: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: m.execFile,
}));
vi.mock('../env-replicate/_shared.js', () => ({ getTaskEnvTemplate: m.getTaskEnvTemplate }));
vi.mock('./_task-meta.js', () => ({ resolveDdevWorkspace: m.resolveDdevWorkspace }));
vi.mock('../onboarding/_helpers.js', () => ({ loadPreviousStepOutput: m.loadPreviousStepOutput }));

import { appBootStep } from './01a-app-boot.js';

const DISABLED =
  'Host execution is disabled: Haive runs a project only inside a container. Build an environment template for this repository so the app can run in its app-runner.';
const ctx = {
  taskId: 'task-1',
  repoPath: '/repo',
  logger: { info: vi.fn(), warn: vi.fn() },
} as never;

let workspace: string;
beforeEach(async () => {
  vi.clearAllMocks();
  m.execFile.mockImplementation((...a: unknown[]) =>
    (a[a.length - 1] as (err: Error) => void)(new Error('spawned')),
  );
  workspace = await mkdtemp(path.join(tmpdir(), 'app-boot-host-'));
  await writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite' } }),
  );
  await writeFile(path.join(workspace, 'pnpm-lock.yaml'), '');
  m.loadPreviousStepOutput.mockResolvedValue({ output: { worktreePath: workspace } });
  m.resolveDdevWorkspace.mockResolvedValue({ repoSubpath: 'u/r' });
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function template(containerTool: string, imageTag: string | null) {
  m.getTaskEnvTemplate.mockResolvedValue({
    status: 'ready',
    imageTag,
    declaredDeps: { containerTool },
  });
}

describe('01a-app-boot never runs a project command on the worker', () => {
  it('apply on the legacy path spawns nothing and says why', async () => {
    const res = await appBootStep.apply(ctx, {
      detected: {
        containerTool: 'docker-compose',
        containerized: false,
        envImageTag: null,
        repoSubpath: null,
        workspacePath: workspace,
        suggestedBootCommand: 'docker compose up -d',
        suggestedInstallCommand: '',
        suggestedPort: 3000,
        skip: false,
      },
      formValues: { bootCommand: 'docker compose up -d', runHealthCheck: true },
      llmOutput: null,
    } as never);
    expect(m.execFile).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      booted: false,
      skipped: false,
      appUrl: null,
      healthCheckPassed: false,
      output: DISABLED,
    });
  });

  it.each(['docker-compose', 'none'])(
    'detect for %s without a container route suggests no boot and skips',
    async (tool) => {
      template(tool, null);
      const detected = await appBootStep.detect!(ctx);
      expect(detected).toMatchObject({
        containerized: false,
        suggestedBootCommand: '',
        skip: true,
        skipReason: DISABLED,
      });
      expect(appBootStep.form!(ctx, detected, null)).toBeNull();
    },
  );

  it('detect keeps the dev-script suggestion on the containerized route', async () => {
    template('none', 'img:tag');
    const detected = await appBootStep.detect!(ctx);
    expect(detected).toMatchObject({
      containerized: true,
      suggestedBootCommand: 'pnpm run dev',
      skip: false,
    });
  });
});
