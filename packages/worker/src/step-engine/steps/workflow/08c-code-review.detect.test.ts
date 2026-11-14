vi.mock('./_fix-test-store.js', () => ({ loadFixTestRecords: vi.fn(async () => []) }));
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: vi.fn(async () => ({ output: { worktreePath: '/wt' } })),
}));
vi.mock('./_spec-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_spec-artifact.js')>()),
  resolveSpecView: vi.fn(async () => ({ text: 'spec', spec: 'spec', condensed: false })),
}));
vi.mock('./_dependency-policy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_dependency-policy.js')>()),
  loadDependencyPolicy: vi.fn(async () => ({ drupal: false, drupalRoots: [], ownedPaths: [] })),
  loadReviewDependencyPolicy: vi.fn(async () => ({
    drupal: false,
    drupalRoots: [],
    ownedPaths: [],
  })),
}));
vi.mock('./_impl-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_impl-changes.js')>()),
  collectImplementationFiles: vi.fn(async () => ({
    files: ['a.ts'],
    total: 1,
    truncated: false,
    scanError: null,
  })),
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  loadTaskMeta: vi.fn(async () => ({ title: 't', description: 'd' })),
}));
vi.mock('../../guidance-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../guidance-context.js')>()),
  isStepGuidanceEnabled: vi.fn(async () => false),
}));
vi.mock('../../review-dimension-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../review-dimension-context.js')>()),
  resolveTaskReviewDimensions: vi.fn(async () => ({ enabled: [] })),
}));

import { ConfigUnavailableError, CONFIG_KEYS, configService, logger } from '@haive/shared';
import { MiningWaveError } from '../../step-definition.js';
import type { AgentMiningResult, StepContext } from '../../step-definition.js';
import { codeReviewStep } from './08c-code-review.js';

const ctx = {
  logger: logger.child({ test: '08c-detect' }),
  taskId: 't1',
  taskStepId: 's1',
  round: 0,
  db: {
    query: {
      taskDagPlans: { findFirst: async () => null },
      tasks: { findFirst: async () => ({ adversarialQaLevel: 'none' }) },
    },
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
  },
} as unknown as StepContext;

const BASE_DETECT = {
  spec: 'the spec',
  implementationFiles: { files: ['a.ts'], total: 1, truncated: false, scanError: null },
  debtBlock: '',
  level: 'none' as const,
};
const CRITICAL_PEER =
  '```json\n{"verdict":"REQUEST_CHANGES","findings":[{"severity":"critical","path":"a.ts","lines":"4","issue":"npe","fix":"guard"}],"positives":[]}\n```';
const CLEAN_SECURITY = '```json\n{"verdict":"SECURE","findings":[]}\n```';
const mining = (agentId: string, rawOutput: string): AgentMiningResult => ({
  agentId,
  agentTitle: agentId,
  status: 'done',
  output: null,
  rawOutput,
  errorMessage: null,
});
const apply = (
  detected: Record<string, unknown>,
  results: AgentMiningResult[],
  miningWaveExhausted: boolean,
) =>
  codeReviewStep.apply(ctx, {
    detected,
    agentMiningResults: results,
    isFinalMiningAttempt: true,
    miningWaveExhausted,
  } as unknown as Parameters<typeof codeReviewStep.apply>[1]);
const firstPass = () =>
  apply(
    BASE_DETECT,
    [mining('peer-reviewer', CRITICAL_PEER), mining('security-code-reviewer', CLEAN_SECURITY)],
    false,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('08c resolves its refutation settings in detect', () => {
  it('carries the lens count and the enabled flag on the detect output', async () => {
    vi.spyOn(configService, 'getNumber').mockResolvedValue(2);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const d = await codeReviewStep.detect!(ctx);
    expect(d.refuteLensCount).toBe(2);
    expect(d.refuteEnabled).toBe(false);
  });

  it('rejects with the outage error before anything is dispatched', async () => {
    const unavailable = new ConfigUnavailableError('get');
    vi.spyOn(configService, 'getNumber').mockRejectedValue(unavailable);
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    await expect(codeReviewStep.detect!(ctx)).rejects.toBe(unavailable);
  });

  it('rejects with the outage error when only the enabled read is down', async () => {
    const unavailable = new ConfigUnavailableError('get');
    vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(unavailable);
    await expect(codeReviewStep.detect!(ctx)).rejects.toBe(unavailable);
  });

  it('leaves the fields unset on any other error, so apply reads live as before', async () => {
    vi.spyOn(configService, 'getNumber').mockRejectedValue(
      new Error('ConfigService not initialized'),
    );
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(
      new Error('ConfigService not initialized'),
    );
    const d = await codeReviewStep.detect!(ctx);
    expect(d.refuteLensCount).toBeUndefined();
    expect(d.refuteEnabled).toBeUndefined();
    expect(d.spec).toBe('spec');
  });
});

describe('08c apply uses the settings carried on the detect output', () => {
  const carried = { ...BASE_DETECT, refuteLensCount: 1, refuteEnabled: true };

  it('does not read the config on the pass that dispatches the wave', async () => {
    const num = vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    const bool = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const err = await apply(
      carried,
      [mining('peer-reviewer', CRITICAL_PEER), mining('security-code-reviewer', CLEAN_SECURITY)],
      false,
    ).catch((e: unknown) => e);
    // The live values (3 lenses, disabled) would have produced no wave at all.
    expect(err).toBeInstanceOf(MiningWaveError);
    expect((err as MiningWaveError).dispatches).toHaveLength(1);
    expect(num).not.toHaveBeenCalled();
    expect(bool).not.toHaveBeenCalled();
  });

  it('does not read the config on the pass that reads the wave back', async () => {
    const num = vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    const bool = vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const first = await apply(
      carried,
      [mining('peer-reviewer', CRITICAL_PEER), mining('security-code-reviewer', CLEAN_SECURITY)],
      false,
    ).catch((e: unknown) => e);
    const wave = (first as MiningWaveError).dispatches;
    const out = await apply(
      carried,
      [
        mining('peer-reviewer', CRITICAL_PEER),
        mining('security-code-reviewer', CLEAN_SECURITY),
        ...wave.map((w) => mining(w.agentId, '```json\n{"refuted":true,"evidence":"a.ts:4"}\n```')),
      ],
      true,
    );
    expect(out.refutedCount).toBe(1);
    expect(out.blocking).toBe(false);
    expect(num).not.toHaveBeenCalled();
    expect(bool).not.toHaveBeenCalled();
  });
});

describe('08c apply with a detect stored before the settings were carried', () => {
  it('falls back to the live read', async () => {
    const num = vi.spyOn(configService, 'getNumber').mockResolvedValue(3);
    const bool = vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    const err = await firstPass().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MiningWaveError);
    expect((err as MiningWaveError).dispatches).toHaveLength(3);
    expect(num).toHaveBeenCalledWith(CONFIG_KEYS.REVIEW_REFUTE_LENSES, expect.any(Number));
    expect(bool).toHaveBeenCalledWith(CONFIG_KEYS.REVIEW_REFUTE_ENABLED, true);
  });

  it('rejects with the outage error when the live read is down', async () => {
    const unavailable = new ConfigUnavailableError('get');
    vi.spyOn(configService, 'getBoolean').mockRejectedValue(unavailable);
    vi.spyOn(configService, 'getNumber').mockRejectedValue(unavailable);
    await expect(firstPass()).rejects.toBe(unavailable);
  });
});
