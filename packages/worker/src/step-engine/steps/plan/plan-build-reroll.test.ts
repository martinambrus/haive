import { describe, expect, it, vi } from 'vitest';
import { planBuildStep } from './01-plan-build.js';
import { applyAgentPatch } from './_plan-prompt.js';
import { MiningRetryError } from '../../step-definition.js';

vi.mock('./_plan-prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_plan-prompt.js')>();
  return { ...actual, applyAgentPatch: vi.fn() };
});
vi.mock('./_plan-semantic-stop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_plan-semantic-stop.js')>();
  return {
    ...actual,
    ensureSemanticExpansionResolution: vi.fn(
      async (_db: unknown, _repo: unknown, _self: unknown, ops: unknown[]) => ops,
    ),
  };
});
vi.mock('./_plan-breadth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_plan-breadth.js')>();
  return { ...actual, assertPlanPatchWithinBreadth: vi.fn(async () => {}) };
});
vi.mock('@haive/shared/plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared/plan')>();
  return {
    ...actual,
    loadPlanSkeletons: vi.fn(async () => []),
    loadPlanEdges: vi.fn(async () => []),
  };
});

/**
 * The whole-wave re-roll. A wave in which no agent wrote anything is worth
 * running again; one whose reply landed, even in part, is not — its nodes are
 * already in the plan, and a re-roll folds the reply a second time.
 */
describe('plan build wave re-roll', () => {
  const NODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const agent = {
    agentId: `plan-expand-${NODE}-p2`,
    agentTitle: 'Expand: Privacy',
    status: 'done',
    output: { ops: [{ op: 'upsert', nodeRef: 'kid', parentRef: 'self', title: 'Consent' }] },
    rawOutput: null,
    errorMessage: null,
  };
  const db = { update: () => ({ set: () => ({ where: () => Promise.resolve() }) }) };

  const foldOneAgentWave = () =>
    planBuildStep
      .apply(
        {
          db,
          taskId: 't',
          taskStepId: 's',
          // Not a repository, so `git rev-parse` fails and links go undated.
          repoPath: '/tmp',
          logger: { warn: () => {}, info: () => {} },
        } as never,
        {
          detected: { repositoryId: 'r1', mode: 'from_repo' },
          formValues: {},
          agentMiningResults: [agent],
          newAgentMiningResults: [agent],
          isFinalMiningAttempt: false,
        } as never,
      )
      .catch((err: unknown) => err);

  it('does not re-roll a one-agent wave whose reply landed with a dropped op', async () => {
    vi.mocked(applyAgentPatch).mockResolvedValueOnce({
      created: ['c'],
      updated: [],
      deleted: [],
      linked: 0,
      unlinked: 0,
      codeLinked: 0,
      refs: { kid: 'c' },
      dropped: ["link dropped: unknown node reference 'x'"],
      strippedCodeLinks: [],
    });
    const err = await foldOneAgentWave();
    expect(err).not.toBeInstanceOf(MiningRetryError);
    // Past the re-roll: the fixture's empty plan is what stops it next.
    expect((err as Error).message).toContain('did not produce a root node');
  });

  it('still re-rolls a one-agent wave whose reply wrote nothing', async () => {
    vi.mocked(applyAgentPatch).mockRejectedValueOnce(
      new Error('plan patch rejected: plan patch failed validation'),
    );
    const err = await foldOneAgentWave();
    expect(err).toBeInstanceOf(MiningRetryError);
    expect((err as MiningRetryError).agentIds).toEqual([agent.agentId]);
  });
});
