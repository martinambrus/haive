import { expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { StepContext } from '../src/step-engine/step-definition.js';
import { skillVerificationStep } from '../src/step-engine/steps/onboarding/09_6-skill-verification.js';

vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  readdirNoFollow: async () => [],
}));
vi.mock('../src/step-engine/_parallel-cap.js', () => ({ resolveParallelCap: async () => 1 }));

it('offers enabled fix CLIs by oldest creation, then lower id', async () => {
  const ids: Record<string, string> = {
    old: '00000000-0000-4000-8000-000000000001',
    new: '00000000-0000-4000-8000-000000000002',
    a: '00000000-0000-4000-8000-000000000003',
    z: '00000000-0000-4000-8000-000000000004',
    disabled: '00000000-0000-4000-8000-000000000005',
  };
  const fake = createFakeDb({ tasks: schema.tasks, cliProviders: schema.cliProviders });
  for (const [id, enabled, createdAt] of [
    ['new', true, '2026-10-20'],
    ['z', true, '2026-10-01'],
    ['a', true, '2026-10-01'],
    ['disabled', false, '2026-09-01'],
  ] as const) {
    fake.insert(schema.cliProviders, {
      id: ids[id],
      userId: '00000000-0000-4000-8000-0000000000a1',
      name: 'codex',
      label: id,
      enabled,
      createdAt: new Date(createdAt),
    });
  }
  const result = await skillVerificationStep.detect!({
    db: fake.db,
    userId: '00000000-0000-4000-8000-0000000000a1',
    taskId: '00000000-0000-4000-8000-0000000000b1',
    cliProviderId: null,
    repoPath: process.cwd(),
    logger: { info: () => {} },
  } as unknown as StepContext);
  expect(result.cliOptions.map((p) => p.label)).toEqual(['a', 'z', 'new']);
});
