import { describe, expect, it, vi } from 'vitest';
vi.mock('./_insight-auto.js', async (original) => ({
  ...(await original<object>()),
  INSIGHT_AUTO_ROUNDS: 2,
}));
import { buildInsightSummary } from './_insight-summary.js';
import { INSIGHT_AUTO_ROUNDS } from './_insight-auto.js';

describe('summary automatic round cap', () => {
  it('uses the configured shared round bound for both stop reason and unclassified outcome', () => {
    const item = {
      id: 'one',
      identity: 'one',
      picked: false,
      sourceStep: 'review',
      title: 'One',
      location: 'a.ts',
      description: 'detail',
    };
    for (const roundsStarted of [INSIGHT_AUTO_ROUNDS - 1, INSIGHT_AUTO_ROUNDS]) {
      const summary = buildInsightSummary([item], [], [], true, { roundsStarted });
      expect(summary.stopReason).toBe(
        roundsStarted < INSIGHT_AUTO_ROUNDS ? 'no_new_consequential' : 'cap',
      );
      expect(summary.items[0]!.outcome).toBe(
        roundsStarted < INSIGHT_AUTO_ROUNDS ? 'not_selected' : 'cap_reached',
      );
    }
  });
});
