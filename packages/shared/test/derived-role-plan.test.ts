import { describe, expect, it } from 'vitest';
import { parseDerivedRunPlan } from '../src/modularity/derived-task-types.js';
import { rolePlan } from './step-role-fixtures.js';

describe('dual pinned-plan decode, without admission', () => {
  it('retains v1 and decodes a future v2 pin without mutating either', () => {
    for (const version of [1, 2] as const) {
      const plan = rolePlan(version);
      const before = JSON.stringify(plan);
      expect(parseDerivedRunPlan(plan)).toEqual(plan);
      expect(JSON.stringify(plan)).toBe(before);
    }
  });
});
