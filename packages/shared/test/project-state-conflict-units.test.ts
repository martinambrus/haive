import { describe, expect, it } from 'vitest';
import { rtkEnabledUpdate } from '../src/tooling/rtk-enabled.js';
import { claimFileName } from '../src/project-state/names.js';
import {
  RENDER_UNIT,
  RTK_ENABLED_UNIT,
  conflictBody,
  isClaimUnit,
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

describe('claim units', () => {
  const unit = claimFileName('.claude/agents/code-reviewer.md');

  it('are the claim file names, siblings of the render unit', () => {
    expect(isClaimUnit(unit)).toBe(true);
    expect(isClaimUnit(claimFileName('docs/#notes.md'))).toBe(true);
    expect(isRenderUnit(unit)).toBe(false);
    expect(isConflictUnit(unit)).toBe(true);
  });

  it('are nothing else that looks like a path', () => {
    for (const other of [
      'artifacts/x.json',
      'artifacts/a/b~0123456789abcdef0123456789abcdef.json',
      'artifacts/a~0123456789ABCDEF0123456789ABCDEF.json',
      'bundles/a~0123456789abcdef0123456789abcdef.json',
      `${unit}#x`,
      `../${unit}`,
    ]) {
      expect(isClaimUnit(other)).toBe(false);
      expect(isConflictUnit(other)).toBe(false);
    }
  });

  it('serve as a body with no render key, even where the file name holds a #', () => {
    const hashed = claimFileName('docs/#notes.md');
    const body = conflictBody({
      id: 'id',
      unit: hashed,
      base: null,
      local: null,
      incoming: null,
      detectedAt: new Date(0),
      resolution: null,
      resolvedAt: null,
    });
    expect(body.key).toBeNull();
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

  it('names a claim by the file it is about, once a side says which', async () => {
    const { conflictUnitLabel } = await import('../src/project-state/conflicts.js');
    const unit = claimFileName('docs/guide.md');
    expect(conflictUnitLabel(unit, 'docs/guide.md')).toBe('the claim for docs/guide.md');
    expect(conflictUnitLabel(unit)).toBe('the claim for a generated file');
  });
});
