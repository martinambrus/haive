import { describe, expect, it } from 'vitest';
import { renderTaskHistoryDigest } from '../src/step-engine/steps/workflow/_task-history-digest.js';

const steer = (text: string, round = 0) => ({
  eventType: 'steering.nudge',
  payload: { text, round, source: 'ui' },
});

describe('renderTaskHistoryDigest steering mining', () => {
  it('renders steering.nudge events in their own section and counts them', () => {
    const d = renderTaskHistoryDigest([], [steer('focus on the SQL perf', 1)]);
    expect(d.steerCount).toBe(1);
    expect(d.text).toContain('## User steering (mid-run course-corrections)');
    expect(d.text).toContain('focus on the SQL perf');
    expect(d.text).toContain('1 user steer(s)');
  });

  it('a steered task is never tier "low" (it had friction worth mining)', () => {
    expect(renderTaskHistoryDigest([], []).tier).toBe('low');
    expect(renderTaskHistoryDigest([], [steer('do X instead')]).tier).not.toBe('low');
  });

  it('three or more steers raises the tier to high', () => {
    const d = renderTaskHistoryDigest([], [steer('a'), steer('b'), steer('c')]);
    expect(d.tier).toBe('high');
  });

  it('no steers: no steering section, steerCount 0, existing reactions path intact', () => {
    const d = renderTaskHistoryDigest(
      [],
      [{ eventType: 'spec.rejected', payload: { feedback: 'add a rollback plan' } }],
    );
    expect(d.steerCount).toBe(0);
    expect(d.text).not.toContain('User steering');
    expect(d.text).toContain('Human reviewer reactions');
  });
});
