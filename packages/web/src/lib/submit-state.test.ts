import { describe, expect, it } from 'vitest';
import { isAwaitingFormInput } from './submit-state';

const STAMP = '2026-09-13T11:08:31.100Z';

describe('isAwaitingFormInput', () => {
  it('is true for a form the worker parked', () => {
    expect(isAwaitingFormInput({ status: 'waiting_form', waitingStartedAt: STAMP })).toBe(true);
  });

  it('is false for a form submitted but not yet picked up', () => {
    // The submit route clears the stamp and leaves the status for the worker to move.
    expect(isAwaitingFormInput({ status: 'waiting_form', waitingStartedAt: null })).toBe(false);
  });

  it('is false for a stamped CLI park', () => {
    expect(isAwaitingFormInput({ status: 'waiting_cli', waitingStartedAt: STAMP })).toBe(false);
  });

  it('is false with no step', () => {
    expect(isAwaitingFormInput(null)).toBe(false);
    expect(isAwaitingFormInput(undefined)).toBe(false);
  });
});
