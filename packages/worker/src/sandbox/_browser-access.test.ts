import { describe, it, expect } from 'vitest';
import { decideDirectAccess } from './_browser-access.js';

// Pure precedence/default for resolveTaskDirectAccess. The config + db reads are left
// untested by design (no config/db mocking in this package — mirrors how ddev-runner
// extracts + tests decideDdevRecovery).
describe('decideDirectAccess', () => {
  it('global kill-switch off => never publish, regardless of the per-task opt-in', () => {
    expect(decideDirectAccess(false, true)).toBe(false);
    expect(decideDirectAccess(false, false)).toBe(false);
    expect(decideDirectAccess(false, null)).toBe(false);
  });

  it('global on + task opted in => publish', () => {
    expect(decideDirectAccess(true, true)).toBe(true);
  });

  it('global on + task not opted in (or legacy null/undefined) => portless default', () => {
    expect(decideDirectAccess(true, false)).toBe(false);
    expect(decideDirectAccess(true, null)).toBe(false);
    expect(decideDirectAccess(true, undefined)).toBe(false);
  });
});
