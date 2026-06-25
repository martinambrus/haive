import type { ForwardedSteer } from './steer-forwarder.js';

/**
 * Ordered queue of steers written to a steerable CLI's stdin but not yet drained
 * by the model. The forwarder records each steer on write; the stream collector
 * drains the whole queue at the next tool-call boundary (Claude merges every
 * queued stdin user-message at once), reporting each as consumed.
 */
export interface SteerTracker {
  /** Record a steer the forwarder just wrote to stdin. */
  recordWritten: (steer: ForwardedSteer) => void;
  /** Return and clear every steer queued since the last drain. Empty when none
   *  are pending. */
  drainConsumed: () => ForwardedSteer[];
}

export function createSteerTracker(): SteerTracker {
  let pending: ForwardedSteer[] = [];
  return {
    recordWritten(steer: ForwardedSteer): void {
      pending.push(steer);
    },
    drainConsumed(): ForwardedSteer[] {
      if (pending.length === 0) return [];
      const drained = pending;
      pending = [];
      return drained;
    },
  };
}
