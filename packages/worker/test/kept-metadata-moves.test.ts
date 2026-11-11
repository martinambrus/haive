import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, h, payload, REPO, setup } from './support/plan-mirror-failure.js';
import { pull, save } from '../src/queues/plan-mirror-queue.js';
import { planMergeStep } from '../src/step-engine/steps/plan/01-plan-merge.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

beforeEach(() => {
  setup();
  h.resync.mockResolvedValue(false);
});
afterEach(cleanup);

const kept = new Map([
  [
    '.haive-data/plan.json',
    {
      bytes: Buffer.from('{}'),
      index: null,
      untracked: true,
      owner: { uid: 1000, gid: 1000 },
      mode: 0o600,
    },
  ],
]);

describe('move callers retain metadata when re-sync does not finish', () => {
  it.each(['pull', 'save', 'confirm'] as const)(
    '%s uses durable settlement and leaves metadata alone',
    async (site) => {
      h.aside.mockResolvedValue({ outcome: 'set-aside', kept });
      if (site === 'pull') await pull(payload);
      else if (site === 'save') await save(payload).catch(() => undefined);
      else
        await planMergeStep
          .apply(
            {
              db: h.db,
              repoPath: '/repo',
              taskId: 't1',
              taskStepId: 's1',
              userId: payload.userId,
            } as StepContext,
            {
              detected: {
                repositoryId: REPO,
                branch: 'main',
                worktreePath: '/repo/merge',
                conflicts: [],
                undecodable: 0,
                attempts: 0,
                transcript: [],
                mergeOpen: false,
              } as never,
              formValues: { decision: 'confirm' },
              iteration: 0,
              previousIterations: [],
              llmOutput: undefined,
            },
          )
          .catch(() => undefined);
      expect(h.resettle).toHaveBeenCalledWith(h.db, REPO, '/repo', kept);
      expect(h.metadata).not.toHaveBeenCalled();
      expect(kept.get('.haive-data/plan.json')?.mode).toBe(0o600);
    },
  );
});
