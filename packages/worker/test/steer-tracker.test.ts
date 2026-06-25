import { describe, expect, it } from 'vitest';
import { createSteerTracker } from '../src/queues/cli-exec/steer-tracker.js';

describe('createSteerTracker', () => {
  it('drains every recorded steer in order, then empties', () => {
    const t = createSteerTracker();
    t.recordWritten({ id: 'a', text: 'one' });
    t.recordWritten({ id: 'b', text: 'two' });
    expect(t.drainConsumed()).toEqual([
      { id: 'a', text: 'one' },
      { id: 'b', text: 'two' },
    ]);
    // Drained — the queue is now empty.
    expect(t.drainConsumed()).toEqual([]);
  });

  it('returns an empty array when nothing is pending', () => {
    const t = createSteerTracker();
    expect(t.drainConsumed()).toEqual([]);
  });

  it('records a fresh batch after a drain (steers queued during the next tool)', () => {
    const t = createSteerTracker();
    t.recordWritten({ id: 'a', text: 'one' });
    expect(t.drainConsumed()).toEqual([{ id: 'a', text: 'one' }]);
    t.recordWritten({ id: 'b', text: 'two' });
    expect(t.drainConsumed()).toEqual([{ id: 'b', text: 'two' }]);
  });
});
