import { describe, expect, it } from 'vitest';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';

describe('registerStepsOnce', () => {
  it('registers every step once and is idempotent', () => {
    expect(stepRegistry.all()).toHaveLength(0);
    registerStepsOnce();
    const ids = stepRegistry.all().map((s) => s.metadata.id);
    expect(ids.length).toBeGreaterThan(100);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => registerStepsOnce()).not.toThrow();
    expect(stepRegistry.all().map((s) => s.metadata.id)).toEqual(ids);
  });
});
