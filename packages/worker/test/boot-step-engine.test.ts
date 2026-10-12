import { describe, expect, it } from 'vitest';
import { bootStepEngine } from '../src/step-engine/boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';

describe('bootStepEngine', () => {
  it('registers every step once and is idempotent', () => {
    expect(stepRegistry.all()).toHaveLength(0);
    bootStepEngine();
    const ids = stepRegistry.all().map((s) => s.metadata.id);
    expect(ids.length).toBeGreaterThan(100);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => bootStepEngine()).not.toThrow();
    expect(stepRegistry.all().map((s) => s.metadata.id)).toEqual(ids);
  });
});
