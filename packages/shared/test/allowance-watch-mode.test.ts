import { describe, expect, it } from 'vitest';
import { ALLOWANCE_WATCH_MODES, parseAllowanceWatchMode } from '../src/config/config.service.js';

describe('parseAllowanceWatchMode', () => {
  it('passes through every valid level', () => {
    for (const mode of ALLOWANCE_WATCH_MODES) {
      expect(parseAllowanceWatchMode(mode)).toBe(mode);
    }
  });

  it('maps the legacy boolean the key held before it became an enum', () => {
    // The Redis key kept its 'autoResumeOnAllowance' name across the boolean->enum
    // change, so an install that had auto-resume switched ON must land on 'auto'
    // rather than silently dropping to the default.
    expect(parseAllowanceWatchMode('true')).toBe('auto');
    expect(parseAllowanceWatchMode('false')).toBe('notify');
  });

  it('defaults to notify for an absent or unrecognized value', () => {
    expect(parseAllowanceWatchMode(null)).toBe('notify');
    expect(parseAllowanceWatchMode(undefined)).toBe('notify');
    expect(parseAllowanceWatchMode('')).toBe('notify');
    expect(parseAllowanceWatchMode('bogus')).toBe('notify');
  });
});
