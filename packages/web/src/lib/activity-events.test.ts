import { describe, expect, it } from 'vitest';
import { activityEvents } from './activity-events';

describe('Activity events', () => {
  it('hides reconcile measurements while retaining user actions and unknown event types', () => {
    const events = [
      { eventType: 'learning.accepted' },
      { eventType: 'learning.reconciled' },
      { eventType: 'learning.refine' },
      { eventType: 'future.user_action' },
    ];
    expect(activityEvents(events)).toEqual([events[0], events[2], events[3]]);
    expect(events).toHaveLength(4);
    expect(activityEvents([events[1]!])).toEqual([]);
  });
});
