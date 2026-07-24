import { describe, it, expect } from 'vitest';
import { admissionKindFromRuntimeMode } from './_app-runtime.js';

describe('admissionKindFromRuntimeMode', () => {
  it('maps a classified runtime to the pooled runner it will spawn', () => {
    expect(admissionKindFromRuntimeMode('ddev')).toBe('ddev');
    expect(admissionKindFromRuntimeMode('app-runner')).toBe('app');
  });

  it('claims no slot for a task that spawns no runner', () => {
    // 'none' is the code-only task (no .ddev/config.yaml, no 01a-app-boot row) and 'host' is the
    // legacy on-worker boot. Neither puts a container in the runtime pool, so neither may park
    // behind it — 07/07b/08 sit in every execution path's SPINE and would otherwise queue every
    // plain bug-fix task behind the DDEV limit.
    expect(admissionKindFromRuntimeMode('none')).toBeNull();
    expect(admissionKindFromRuntimeMode('host')).toBeNull();
  });
});
