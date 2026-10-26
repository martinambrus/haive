import { describe, expect, it } from 'vitest';
import {
  foreignReason,
  isNewerRelease,
  isRenderContextSnapshot,
  PROJECT_STATE_IMPORT_STEP_ID,
  type ForeignCandidate,
} from '../src/project-state/index.js';

const CLAUDE = { dir: '.claude/agents', format: 'markdown' as const, supportsLsp: false };
const CONTEXT = { haiveVersion: '1.4.0', agentTargets: [CLAUDE], skillDirs: ['.claude/skills'] };

const marker = (partial: Partial<ForeignCandidate> = {}): ForeignCandidate => ({
  templateId: 'agent.x',
  templateKind: 'agent',
  diskPath: '.claude/agents/x.md',
  source: 'backfill',
  sourceStepId: PROJECT_STATE_IMPORT_STEP_ID,
  haiveVersion: '1.4.0',
  ...partial,
});

const local = (partial: Partial<ForeignCandidate> = {}): ForeignCandidate =>
  marker({ source: 'upgrade', sourceStepId: '02-upgrade-apply', ...partial });

describe('isNewerRelease', () => {
  it('orders plain releases numerically, not as text', () => {
    expect(isNewerRelease('1.4.1', '1.4.0')).toBe(true);
    expect(isNewerRelease('1.10.0', '1.9.9')).toBe(true);
    expect(isNewerRelease('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerRelease('1.4.0', '1.4.0')).toBe(false);
    expect(isNewerRelease('1.3.9', '1.4.0')).toBe(false);
    expect(isNewerRelease('0.9.0', '0.10.0')).toBe(false);
  });

  it('is never newer when either side is not a plain release', () => {
    expect(isNewerRelease('9.9.9', '0.0.0-dev')).toBe(false);
    expect(isNewerRelease('0.0.0-dev', '1.0.0')).toBe(false);
    expect(isNewerRelease('0.0.0-dev', '0.0.0-dev')).toBe(false);
    expect(isNewerRelease('2.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isNewerRelease('2.0.0', '1.0.0-rc.1')).toBe(false);
    expect(isNewerRelease('v2.0.0', '1.0.0')).toBe(false);
    expect(isNewerRelease('01.0.0', '0.9.0')).toBe(false);
    expect(isNewerRelease('', '1.0.0')).toBe(false);
    expect(isNewerRelease(null, '1.0.0')).toBe(false);
    expect(isNewerRelease('2.0.0', null)).toBe(false);
  });
});

describe('foreignReason', () => {
  it('reads an unmapped bundle item as foreign, imported or not', () => {
    const row = { templateId: 'custom:git@host/a/b:items/x', templateKind: 'custom-agent' };
    expect(foreignReason(local(row), CONTEXT)).toBe('custom-bundle');
    expect(foreignReason(marker(row), CONTEXT)).toBe('custom-bundle');
    expect(foreignReason(local({ templateId: 'custom.b.i' }), CONTEXT)).toBeNull();
  });

  it('reads a marker from a newer release as foreign, and only a marker', () => {
    expect(foreignReason(marker({ haiveVersion: '1.4.1' }), CONTEXT)).toBe('newer-release');
    expect(foreignReason(local({ haiveVersion: '1.4.1' }), CONTEXT)).toBeNull();
    expect(foreignReason(marker({ haiveVersion: '1.4.0' }), CONTEXT)).toBeNull();
    expect(foreignReason(marker({ haiveVersion: null }), CONTEXT)).toBeNull();
  });

  it('never reads a marker as newer on a dev build', () => {
    expect(
      foreignReason(marker({ haiveVersion: '9.0.0' }), { ...CONTEXT, haiveVersion: '0.0.0-dev' }),
    ).toBeNull();
  });

  it('reads a marker at a path this install does not render to as foreign', () => {
    const codex = { diskPath: '.codex/agents/x.toml' };
    expect(foreignReason(marker(codex), CONTEXT)).toBe('not-rendered');
    expect(foreignReason(local(codex), CONTEXT)).toBeNull();
    expect(foreignReason(marker(), CONTEXT)).toBeNull();
    expect(
      foreignReason(
        marker({
          templateKind: 'agents-index',
          templateId: 'agents-index',
          diskPath: '.codex/agents/README.md',
        }),
        CONTEXT,
      ),
    ).toBe('not-rendered');
  });

  it('judges a custom item by the id its path carries', () => {
    const agent = (diskPath: string) =>
      marker({ templateKind: 'custom-agent', templateId: 'custom.b.i', diskPath });
    expect(foreignReason(agent('.claude/agents/a.md'), CONTEXT)).toBeNull();
    expect(foreignReason(agent('.codex/agents/a.toml'), CONTEXT)).toBe('not-rendered');
    const skill = (diskPath: string) =>
      marker({ templateKind: 'custom-skill', templateId: 'custom.b.i', diskPath });
    expect(foreignReason(skill('.claude/skills/s/SKILL.md'), CONTEXT)).toBeNull();
    expect(foreignReason(skill('.claude/skills/s/sub-skills/p.md'), CONTEXT)).toBeNull();
    expect(foreignReason(skill('.agents/skills/s/SKILL.md'), CONTEXT)).toBe('not-rendered');
  });

  it('leaves the targets unjudged where no render context resolves, and other kinds alone', () => {
    const codex = marker({ diskPath: '.codex/agents/x.toml' });
    expect(foreignReason(codex, { ...CONTEXT, agentTargets: null })).toBeNull();
    expect(
      foreignReason(
        marker({ templateKind: 'cli-rules', templateId: 'cli-rules', diskPath: 'AGENTS.md' }),
        CONTEXT,
      ),
    ).toBeNull();
  });
});

describe('removed imported targets with reduced explicit membership', () => {
  const snapshot = (cliTargets: string[]) => ({
    projectInfo: {},
    framework: null,
    acceptedAgentIds: ['code-reviewer'],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkEnabled: false,
    cliTargets,
  });
  const removed = [
    {
      templateId: 'agent.code-reviewer',
      templateKind: 'agent',
      diskPath: '.codex/agents/code-reviewer.toml',
    },
    {
      templateId: 'agents-index',
      templateKind: 'agents-index',
      diskPath: '.codex/agents/README.md',
    },
    {
      templateId: 'custom.b.i',
      templateKind: 'custom-agent',
      diskPath: '.codex/agents/reviewer.toml',
      specId: 'reviewer',
    },
    {
      templateId: 'custom.b.i',
      templateKind: 'custom-skill',
      diskPath: '.agents/skills/reviewing/SKILL.md',
      specId: 'reviewing',
    },
    {
      templateId: 'custom.b.i',
      templateKind: 'custom-skill',
      diskPath: '.agents/skills/reviewing/sub-skills/inspect.md',
      specId: 'reviewing',
    },
  ];
  for (const names of [['claude-code', 'future-cli'], []]) {
    it.each(removed)(
      'allows ordinary cleanup of $diskPath with reduced members ' + JSON.stringify(names),
      (row) => {
        const formValuesSnapshot = snapshot(names);
        expect(isRenderContextSnapshot(formValuesSnapshot)).toBe(true);
        expect(formValuesSnapshot.cliTargets).not.toContain('codex');
        expect(
          foreignReason(marker({ ...row, formValuesSnapshot }), {
            haiveVersion: '1.4.0',
            agentTargets: names.length ? [CLAUDE] : [],
            skillDirs: names.length ? ['.claude/skills'] : [],
          }),
        ).toBeNull();
      },
    );
  }
  it('keeps legacy, malformed and genuinely unknown destination claims foreign', () => {
    const { cliTargets: _missing, ...legacy } = snapshot([]);
    const codex = removed[0]!;
    for (const formValuesSnapshot of [null, legacy, { ...snapshot([]), unexpected: true }])
      expect(foreignReason(marker({ ...codex, formValuesSnapshot }), CONTEXT)).toBe('not-rendered');
    for (const diskPath of [
      '.future/agents/code-reviewer.toml',
      '.codex/agents/elsewhere/code-reviewer.toml',
    ])
      expect(
        foreignReason(marker({ ...codex, diskPath, formValuesSnapshot: snapshot([]) }), CONTEXT),
      ).toBe('not-rendered');
    expect(
      foreignReason(
        marker({
          ...removed[3],
          diskPath: '.future/skills/reviewing/SKILL.md',
          formValuesSnapshot: snapshot([]),
        }),
        CONTEXT,
      ),
    ).toBe('not-rendered');
  });
  it('keeps newer releases and unavailable custom bundles foreign under an explicit empty contract', () => {
    expect(
      foreignReason(
        marker({ ...removed[0], haiveVersion: '1.4.1', formValuesSnapshot: snapshot([]) }),
        CONTEXT,
      ),
    ).toBe('newer-release');
    expect(
      foreignReason(
        marker({
          ...removed[3],
          templateId: 'custom:unavailable:item',
          formValuesSnapshot: snapshot([]),
        }),
        CONTEXT,
      ),
    ).toBe('custom-bundle');
  });
});
