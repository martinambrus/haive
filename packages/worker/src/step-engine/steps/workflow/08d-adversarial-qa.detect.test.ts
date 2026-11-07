import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: vi.fn(async () => ({ output: { worktreePath: '/wt' } })),
}));
vi.mock('./_spec-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_spec-artifact.js')>()),
  resolveSpecView: vi.fn(async () => ({ text: 'spec', spec: 'spec', condensed: false })),
}));
vi.mock('./_impl-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_impl-changes.js')>()),
  collectImplementationFiles: vi.fn(async () => ({
    files: ['a.php'],
    total: 1,
    truncated: false,
    scanError: null,
  })),
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  loadAppBootOutput: vi.fn(async () => null),
}));
vi.mock('../../guidance-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../guidance-context.js')>()),
  isStepGuidanceEnabled: vi.fn(async () => false),
}));

import { ConfigUnavailableError, CONFIG_KEYS, configService } from '@haive/shared';
import { MiningWaveError } from '../../step-definition.js';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { adversarialQaStep } from './08d-adversarial-qa.js';

const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  db: {
    query: {
      taskDagPlans: { findFirst: async () => null },
      tasks: { findFirst: async () => ({ adversarialQaLevel: 'poc' }) },
    },
    insert: () => ({ values: () => ({ onConflictDoNothing: () => Promise.resolve() }) }),
  },
  taskId: 't',
  taskStepId: 's',
  round: 0,
} as unknown as StepContext;

const BASE_DETECT = {
  level: 'poc' as const,
  spec: 's',
  implementationFiles: { files: ['a.php'], total: 1, truncated: false, scanError: null },
  appUrl: 'https://x.ddev.site',
};
const BLOCKER = { severity: 'critical', location: 'admin.php:10', impact: 'rce', poc: 'GET /x' };
const adversary = (): AgentMiningResult => ({
  agentId: 'auth-bandit',
  agentTitle: 'auth-bandit',
  invocationId: 'inv-auth-bandit',
  status: 'done',
  output: null,
  rawOutput:
    '```json\n' + JSON.stringify({ verdict: 'NEEDS_FIXES', findings: [BLOCKER] }) + '\n```',
  errorMessage: null,
});
const apply = (detected: Record<string, unknown>, results: AgentMiningResult[]) =>
  adversarialQaStep.apply(ctx, {
    detected,
    agentMiningResults: results,
    isFinalMiningAttempt: true,
  } as unknown as Parameters<typeof adversarialQaStep.apply>[1]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('08d resolves its verification settings in detect', () => {
  it('carries the lens count and the enabled flag on the detect output', async () => {
    vi.spyOn(configService, 'getNumber').mockResolvedValue(2);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const d = await adversarialQaStep.detect!(ctx);
    expect(d.verifyLensCount).toBe(2);
    expect(d.verifyEnabled).toBe(false);
  });

  it('rejects with the outage error before anything is dispatched', async () => {
    const unavailable = new ConfigUnavailableError('get');
    vi.spyOn(configService, 'getNumber').mockRejectedValue(unavailable);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    await expect(adversarialQaStep.detect!(ctx)).rejects.toBe(unavailable);
  });

  it('rejects with the outage error when only the enabled read is down', async () => {
    const unavailable = new ConfigUnavailableError('get');
    vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(unavailable);
    await expect(adversarialQaStep.detect!(ctx)).rejects.toBe(unavailable);
  });

  it('leaves the fields unset on any other error, so apply reads live as before', async () => {
    vi.spyOn(configService, 'getNumber').mockRejectedValue(
      new Error('ConfigService not initialized'),
    );
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(
      new Error('ConfigService not initialized'),
    );
    const d = await adversarialQaStep.detect!(ctx);
    expect(d.verifyLensCount).toBeUndefined();
    expect(d.verifyEnabled).toBeUndefined();
    expect(d.spec).toBe('spec');
  });
});

describe('08d apply uses the settings carried on the detect output', () => {
  const carried = { ...BASE_DETECT, verifyLensCount: 1, verifyEnabled: true };

  it('does not read the config on the pass that dispatches the wave', async () => {
    const num = vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    const bool = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const err = await apply(carried, [adversary()]).catch((e: unknown) => e);
    // The live values (disabled) would have produced no wave at all.
    expect(err).toBeInstanceOf(MiningWaveError);
    expect((err as MiningWaveError).dispatches).toHaveLength(1);
    expect(num).not.toHaveBeenCalled();
    expect(bool).not.toHaveBeenCalled();
  });

  it('does not read the config on the pass that reads the wave back', async () => {
    const num = vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    const bool = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const first = await apply(carried, [adversary()]).catch((e: unknown) => e);
    const verifiers: AgentMiningResult[] = (first as MiningWaveError).dispatches.map((d) => ({
      agentId: d.agentId,
      agentTitle: d.agentTitle,
      invocationId: 'inv-v',
      status: 'done',
      output: null,
      rawOutput:
        '```json\n' +
        JSON.stringify({
          verdicts: [
            {
              finding: 1,
              reproduced: false,
              observation:
                'Issued GET https://x.ddev.site/x and got 404 with an empty body, no shell',
            },
          ],
        }) +
        '\n```',
      errorMessage: null,
    }));
    const out = await apply(carried, [adversary(), ...verifiers]);
    expect(out.findings[0]!.verification).toBe('not_reproduced');
    expect(num).not.toHaveBeenCalled();
    expect(bool).not.toHaveBeenCalled();
  });
});

describe('08d apply with a detect stored before the settings were carried', () => {
  it('falls back to the live read', async () => {
    const num = vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    const bool = vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    const err = await apply(BASE_DETECT, [adversary()]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningWaveError);
    expect((err as MiningWaveError).dispatches).toHaveLength(3);
    expect(num).toHaveBeenCalledWith(CONFIG_KEYS.QA_VERIFY_LENSES, expect.any(Number));
    expect(bool).toHaveBeenCalledWith(CONFIG_KEYS.QA_VERIFY_ENABLED, true);
  });

  it('rejects with the outage error when the live read is down', async () => {
    const unavailable = new ConfigUnavailableError('get');
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(unavailable);
    vi.spyOn(configService, 'getNumber').mockRejectedValue(unavailable);
    await expect(apply(BASE_DETECT, [adversary()])).rejects.toBe(unavailable);
  });
});
