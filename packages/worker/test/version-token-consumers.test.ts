import { expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { declareDepsStep } from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import { generateDockerfileStep } from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { resolveSandboxImageTag } from '../src/queues/cli-exec/images.js';
import type { StepContext } from '../src/step-engine/step-definition.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';

function setup(pins: Record<string, unknown>, deps: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    tasks: schema.tasks,
    repositories: schema.repositories,
    envTemplates: schema.envTemplates,
    cliProviders: schema.cliProviders,
  });
  fake.insert(schema.tasks, {
    id: '00000000-0000-4000-8000-000000000001',
    repositoryId: '00000000-0000-4000-8000-000000000002',
    envTemplateId: '00000000-0000-4000-8000-000000000003',
  });
  fake.insert(schema.repositories, { id: '00000000-0000-4000-8000-000000000002', ...pins });
  fake.insert(schema.envTemplates, {
    id: '00000000-0000-4000-8000-000000000003',
    baseImage: 'ubuntu:24.04',
    declaredDeps: deps,
    generatedDockerfile: 'FROM ubuntu:24.04\nRUN echo kept\n',
  });
  const ctx = {
    taskId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000005',
    cliProviderId: null,
    db: fake.db,
    logger: { info: vi.fn() },
  } as unknown as StepContext;
  return { fake, ctx };
}

it.each(['1.2.3\nRUN id', '1.2.3\n', '$(id)'])(
  'refuses stored pins %j before copying them into declared dependencies',
  async (token) => {
    for (const pins of [
      { lspServerVersions: { pyright: token } },
      { chromeDevtoolsMcpVersion: token },
    ]) {
      const { fake, ctx } = setup(pins);
      const before = fake.rows(schema.envTemplates);
      await expect(
        declareDepsStep.apply(ctx, {
          formValues: { runtimes: [], containerTool: 'none' },
          detected: { runtimes: [], cliSupportsLsp: true },
          iteration: 0,
          previousIterations: [],
        } as unknown as Parameters<typeof declareDepsStep.apply>[1]),
      ).rejects.toThrow(/version token/);
      expect(fake.rows(schema.envTemplates)).toEqual(before);
    }
  },
);

it('refuses invalid stored dependency pins even when saved Dockerfile text could be reused', async () => {
  const { ctx } = setup({}, { lspServerVersions: { pyright: '$(id)' } });
  await expect(generateDockerfileStep.detect!(ctx)).rejects.toThrow(/version token/);
});

it('does not trim a stored CLI version before resolving the provider image', async () => {
  const { ctx } = setup({});
  const inspect = vi.fn(async () => ({ exists: true }));
  await expect(
    resolveSandboxImageTag(
      ctx.db,
      null,
      {
        id: '00000000-0000-4000-8000-000000000004',
        userId: '00000000-0000-4000-8000-000000000005',
        name: 'codex',
        cliVersion: '1.2.3\n',
        sandboxDockerfileExtra: null,
      },
      { inspect } as unknown as DockerRunner,
    ),
  ).rejects.toThrow(/version token/);
  expect(inspect).not.toHaveBeenCalled();
});
