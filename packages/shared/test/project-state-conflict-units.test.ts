import { describe, expect, it } from 'vitest';
import { rtkEnabledUpdate } from '../src/tooling/rtk-enabled.js';
import {
  RENDER_UNIT,
  RTK_ENABLED_UNIT,
  isConflictUnit,
  isRenderUnit,
} from '../src/project-state/conflicts.js';

describe('conflict units', () => {
  it('names the RTK question by one constant that is no render unit', () => {
    expect(RTK_ENABLED_UNIT).toBe('settings/rtk-enabled.json');
    expect(isRenderUnit(RTK_ENABLED_UNIT)).toBe(false);
  });

  it('accepts the render unit, a key of it and the RTK unit, and nothing else', () => {
    expect(isConflictUnit(RENDER_UNIT)).toBe(true);
    expect(isConflictUnit(`${RENDER_UNIT}#framework`)).toBe(true);
    expect(isConflictUnit(RTK_ENABLED_UNIT)).toBe(true);
    expect(isConflictUnit('settings/other.json')).toBe(false);
    expect(isConflictUnit(`${RTK_ENABLED_UNIT}#x`)).toBe(false);
  });
});

describe('rtkEnabledUpdate', () => {
  it('sets the column and the time it changed, and nothing else', () => {
    const before = Date.now();
    const off = rtkEnabledUpdate(false);
    expect(Object.keys(off).sort()).toEqual(['rtkEnabled', 'updatedAt']);
    expect(off.rtkEnabled).toBe(false);
    expect(off.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(rtkEnabledUpdate(true).rtkEnabled).toBe(true);
  });
});

describe('conflictUnitLabel', () => {
  it('names each unit as a person knows it rather than by its path', async () => {
    const { conflictUnitLabel } = await import('../src/project-state/conflicts.js');
    expect(conflictUnitLabel('settings/rtk-enabled.json')).toBe('RTK command compression');
    expect(conflictUnitLabel('project/render.json')).toBe('The whole project record file');
    expect(conflictUnitLabel('project/render.json#framework')).toBe('Framework');
    expect(conflictUnitLabel('project/render.json#somethingNew')).toBe('somethingNew');
  });
});
