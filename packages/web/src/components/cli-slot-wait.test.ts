import { describe, expect, it } from 'vitest';
import { describeSlotHolders } from './cli-slot-wait';

const q = (agents: number, service: number) => ({ running: agents + service, agents, service });

describe('describeSlotHolders', () => {
  it('names agent runs when only agents hold the slots', () => {
    expect(describeSlotHolders(q(3, 0))).toBe('3 agent runs are using them');
    expect(describeSlotHolders(q(1, 0))).toBe('1 agent run is using them');
  });

  // The measured case: four stale cli-refresh-versions jobs held every slot while every task
  // the user owned was paused, and the old copy blamed "4 jobs".
  it('names CLI upkeep when no agent is running', () => {
    expect(describeSlotHolders(q(0, 4))).toBe('4 CLI upkeep jobs are using them');
    expect(describeSlotHolders(q(0, 1))).toBe('1 CLI upkeep job is using them');
  });

  it('names both when the slots are mixed', () => {
    expect(describeSlotHolders(q(2, 1))).toBe('2 agent runs and 1 CLI upkeep job are using them');
  });

  // A pre-split api sends neither count. Report the total unattributed rather than claim a
  // breakdown that was never sent — "0 agent runs" would be a fabricated fact.
  it('falls back to the plain count when the api sent no breakdown', () => {
    expect(describeSlotHolders({ running: 4, agents: 0, service: 0 })).toBe(
      '4 jobs are using them all',
    );
    expect(describeSlotHolders({ running: 1, agents: 0, service: 0 })).toBe(
      '1 job is using them all',
    );
  });
});
