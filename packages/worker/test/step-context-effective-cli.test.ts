import { describe, expect, it } from 'vitest';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { realSkipDecision, realStepContext } from './support/real-step-context.js';

const day = (d: number): Date => new Date(Date.UTC(2026, 0, d));
const P_NEW = 'cccccccc-0000-4000-8000-000000000003';
const P_OLDEST = 'bbbbbbbb-0000-4000-8000-000000000002';
const P_DISABLED_OLDER = 'aaaaaaaa-0000-4000-8000-000000000001';

const providers = [
  { id: P_NEW, enabled: true, createdAt: day(20) },
  { id: P_OLDEST, enabled: true, createdAt: day(10) },
  { id: P_DISABLED_OLDER, enabled: false, createdAt: day(1) },
];

describe('the CLI a step context carries for a task', () => {
  it('is the oldest enabled provider for a task with none', async () => {
    const ctx = await realStepContext({ cliProviderId: null, providers });
    expect(ctx.cliProviderId).toBe(P_OLDEST);
  });

  it('breaks a createdAt tie by the lower id, whatever the input order', async () => {
    const lo = { id: 'a0000000-0000-4000-8000-000000000001', enabled: true, createdAt: day(5) };
    const hi = { id: 'f0000000-0000-4000-8000-000000000009', enabled: true, createdAt: day(5) };
    for (const order of [
      [lo, hi],
      [hi, lo],
    ]) {
      const ctx = await realStepContext({ cliProviderId: null, providers: order });
      expect(ctx.cliProviderId).toBe(lo.id);
    }
  });

  it("keeps the task's own provider although an older one exists", async () => {
    const ctx = await realStepContext({ cliProviderId: P_NEW, providers });
    expect(ctx.cliProviderId).toBe(P_NEW);
  });

  it("keeps the task's own provider when that one is disabled", async () => {
    const ctx = await realStepContext({ cliProviderId: P_DISABLED_OLDER, providers });
    expect(ctx.cliProviderId).toBe(P_DISABLED_OLDER);
  });

  it('is null when there are no providers, none are passed, or none is enabled', async () => {
    expect(
      (await realStepContext({ cliProviderId: null, providers: [] })).cliProviderId,
    ).toBeNull();
    expect((await realStepContext({ cliProviderId: null })).cliProviderId).toBeNull();
    const allOff = providers.map((p) => ({ ...p, enabled: false }));
    expect(
      (await realStepContext({ cliProviderId: null, providers: allOff })).cliProviderId,
    ).toBeNull();
  });
});

describe('willSkipBeforeAdmission for a step that needs a CLI', () => {
  const needsCli = {
    metadata: { id: 'needs-cli', workflowType: 'workflow', index: 0, title: 'needs cli' },
    shouldRun: async (ctx: { cliProviderId: string | null }) => ctx.cliProviderId !== null,
  } as unknown as StepDefinition;

  it('does not skip a none task that has an enabled provider', async () => {
    const out = await realSkipDecision({ cliProviderId: null, providers }, needsCli);
    expect(out.skipped).toBe(false);
  });

  it('skips a none task with no provider', async () => {
    const out = await realSkipDecision({ cliProviderId: null, providers: [] }, needsCli);
    expect(out.skipped).toBe(true);
  });
});
