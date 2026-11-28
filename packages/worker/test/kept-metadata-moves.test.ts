import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, h, payload, REPO, setup } from './support/plan-mirror-failure.js';
import { pull, save } from '../src/queues/plan-mirror-queue.js';
import { planMergeStep } from '../src/step-engine/steps/plan/01-plan-merge.js';
import type { Database } from '@haive/database';
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

import { logger } from '@haive/shared';
import { vi } from 'vitest';

describe('move callers retain metadata when re-sync does not finish', () => {
  it.each(['pull', 'save', 'confirm'] as const)(
    '%s uses durable settlement and leaves metadata alone',
    async (site) => {
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      h.aside.mockResolvedValue({ outcome: 'set-aside', kept });
      if (site === 'pull')
        expect(await pull(payload)).toMatchObject({ pulled: { fastForwarded: true } });
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
      expect(
        warning.mock.calls.some(
          ([, message]) => message === 'plan pulled; projection recovery pending',
        ),
      ).toBe(false);
      warning.mockRestore();
      // Plan operations pass the callback-draining facade over this same database.
      const expectedDb =
        site === 'confirm' ? h.db : expect.objectContaining({ query: (h.db as Database).query });
      if (site === 'pull')
        expect(h.resettle).toHaveBeenCalledWith(expectedDb, REPO, '/repo', kept, 'plan_pull');
      else expect(h.resettle).toHaveBeenCalledWith(expectedDb, REPO, '/repo', kept);
      // objectContaining(query) also matches the raw database; a plan operation must pass the facade.
      if (site !== 'confirm') expect(h.resettle.mock.calls[0]![0]).not.toBe(h.db);
      expect(h.metadata).not.toHaveBeenCalled();
      expect(kept.get('.haive-data/plan.json')?.mode).toBe(0o600);
    },
  );
});
