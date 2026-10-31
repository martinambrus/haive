import { describe, expect, it } from 'vitest';
import { rtkEnabledUpdate } from '../src/tooling/rtk-enabled.js';
import { claimFileName } from '../src/project-state/names.js';
import {
  RENDER_UNIT,
  RTK_ENABLED_UNIT,
  blocksUpgrade,
  conflictBody,
  conflictUnitLabel,
  isClaimUnit,
  isConflictUnit,
  isEnvironmentUnit,
  isRenderUnit,
  isRtkQuestion,
  isSettingUnit,
  parsePlanConflictUnit,
  planConflictUnit,
} from '../src/project-state/conflicts.js';
import { PORTABLE_SETTING_NAMES } from '../src/project-state/settings.js';
import { settingFileName } from '../src/project-state/index.js';

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

describe('setting and environment units', () => {
  it('are conflict units: each portable setting file, the environment and a key of it', () => {
    for (const name of PORTABLE_SETTING_NAMES)
      expect(isConflictUnit(settingFileName(name))).toBe(true);
    expect(isConflictUnit('project/environment.json')).toBe(true);
    expect(isConflictUnit('project/environment.json#confirmedValues')).toBe(true);
    expect(isSettingUnit('settings/lsp-servers.json')).toBe(true);
    expect(isEnvironmentUnit('project/environment.json#envDetectData')).toBe(true);
  });

  it('are nothing else that looks like one', () => {
    for (const other of [
      'settings/app-auth.json',
      'settings/verify-commands.json',
      'settings/lsp-servers.json#x',
      'settings/../lsp-servers.json',
      'project/environment.jsonx',
    ]) {
      expect(isConflictUnit(other)).toBe(false);
    }
  });

  it('are the agent rules by their .md file alone', () => {
    expect(isSettingUnit('settings/agent-rules.md')).toBe(true);
    expect(isConflictUnit('settings/agent-rules.md')).toBe(true);
    for (const other of [
      'settings/agent-rules.json',
      'settings/agent-rules.md#x',
      'settings/rtk-version.md',
      'settings/lsp-servers.md',
      'settings/other.md',
    ]) {
      expect(isSettingUnit(other)).toBe(false);
      expect(isConflictUnit(other)).toBe(false);
    }
  });

  it('hold an upgrade only for render, claim and RTK units', () => {
    expect(blocksUpgrade(RTK_ENABLED_UNIT)).toBe(true);
    expect(blocksUpgrade(RENDER_UNIT)).toBe(true);
    expect(blocksUpgrade(`${RENDER_UNIT}#framework`)).toBe(true);
    expect(blocksUpgrade(claimFileName('docs/a.md'))).toBe(true);
    for (const name of PORTABLE_SETTING_NAMES.filter((n) => n !== 'rtk-enabled')) {
      expect(blocksUpgrade(settingFileName(name))).toBe(false);
    }
    expect(blocksUpgrade('settings/agent-rules.md')).toBe(false);
    expect(blocksUpgrade('project/environment.json')).toBe(false);
    expect(blocksUpgrade('project/environment.json#confirmedValues')).toBe(false);
    expect(blocksUpgrade('settings/app-auth.json')).toBe(false);
  });

  it('name the RTK question by its sides: base equals local', () => {
    const side = (v: unknown) => ({ v });
    expect(isRtkQuestion({ unit: RTK_ENABLED_UNIT, base: side(true), local: side(true) })).toBe(
      true,
    );
    expect(isRtkQuestion({ unit: RTK_ENABLED_UNIT, base: side(true), local: side(false) })).toBe(
      false,
    );
    expect(
      isRtkQuestion({ unit: 'settings/lsp-servers.json', base: side(1), local: side(1) }),
    ).toBe(false);
  });

  it('are labelled as a person knows them', () => {
    expect(conflictUnitLabel('settings/lsp-servers.json')).toBe('Language servers');
    expect(conflictUnitLabel('settings/review-dimensions.json')).toBe('Review dimensions');
    expect(conflictUnitLabel('settings/agent-rules.md')).toBe('AGENTS.md rules');
    expect(conflictUnitLabel('settings/scope-exclude-globs.json')).toBe(
      'Paths left out of the project scope',
    );
    expect(conflictUnitLabel('project/environment.json')).toBe('The project environment');
    expect(conflictUnitLabel('project/environment.json#envDetectData')).toBe(
      'Detected environment',
    );
    expect(conflictUnitLabel('project/environment.json#other')).toBe('other');
  });

  it('serve as a body with the key of the environment, and none for a setting', () => {
    const base = { id: 'x', base: null, local: null, incoming: null, detectedAt: new Date(0) };
    const body = (unit: string) =>
      conflictBody({ ...base, unit, resolution: null, resolvedAt: null });
    expect(body('project/environment.json#confirmedValues').key).toBe('confirmedValues');
    expect(body('settings/lsp-servers.json').key).toBeNull();
    expect(body('settings/agent-rules.md').key).toBeNull();
  });
});

describe('plan units', () => {
  const nodeId = '00000000-0000-4000-8000-0000000000c1';

  it('name one field of one node and read back as it', () => {
    expect(planConflictUnit(nodeId, 'title')).toBe(`plan/${nodeId}#title`);
    expect(parsePlanConflictUnit(planConflictUnit(nodeId, 'status'))).toEqual({
      nodeId,
      field: 'status',
    });
  });

  it('are conflict units the api serves, and no upgrade waits on one', () => {
    for (const field of ['title', 'body', 'kind', 'status', 'taskable']) {
      const unit = planConflictUnit(nodeId, field);
      expect(isConflictUnit(unit)).toBe(true);
      expect(blocksUpgrade(unit)).toBe(false);
    }
  });

  it('are no conflict unit when the field is not one a person is asked about', () => {
    for (const field of ['ordinal', 'parentId', 'nope']) {
      expect(isConflictUnit(planConflictUnit(nodeId, field))).toBe(false);
    }
  });

  it('are labelled by their field', () => {
    expect(conflictUnitLabel(planConflictUnit(nodeId, 'status'))).toBe('Plan: status of a node');
  });

  it('refuse a unit that names no node or no field', () => {
    for (const unit of ['plan/', `plan/${nodeId}`, `plan/${nodeId}#`, 'plan/#title', RENDER_UNIT]) {
      expect(parsePlanConflictUnit(unit)).toBeNull();
    }
  });
});
