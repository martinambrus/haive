import { describe, expect, it } from 'vitest';
import {
  agentFilePath,
  bundleItemRenders,
  FALLBACK_AGENT_TARGET,
  originAgentTargets,
  renderTargetsFor,
  rendersAt,
  shouldEmitAgentsReadme,
  skillTargetDirs,
} from '../src/project-state/index.js';

const rows = (...enabled: string[]) =>
  ['claude-code', 'codex', 'gemini', 'amp', 'zai'].map((name) => ({
    name: name as 'claude-code',
    enabled: enabled.includes(name),
  }));
const CLAUDE = { dir: '.claude/agents', format: 'markdown' as const };
const CODEX = { dir: '.codex/agents', format: 'toml' as const };
const GEMINI = { dir: '.gemini/agents', format: 'markdown' as const };

describe('render targets', () => {
  it('names an agent file by its target format', () => {
    expect(agentFilePath(CLAUDE, 'x')).toBe('.claude/agents/x.md');
    expect(agentFilePath(CODEX, 'x')).toBe('.codex/agents/x.toml');
  });

  it('keeps the index README out of the gemini directory only', () => {
    expect(shouldEmitAgentsReadme(GEMINI)).toBe(false);
    expect(shouldEmitAgentsReadme(CLAUDE)).toBe(true);
  });

  it('collapses CLIs sharing a skills directory and falls back only when none has one', () => {
    expect(skillTargetDirs(['claude-code', 'zai', 'amp'])).toEqual(['.claude/skills']);
    expect(skillTargetDirs(['claude-code', 'codex'])).toEqual(['.claude/skills', '.agents/skills']);
    expect(skillTargetDirs([])).toEqual([]);
    expect(skillTargetDirs([], ['.claude/skills'])).toEqual(['.claude/skills']);
  });

  it('derives one agent target per directory, the fallback only on request', () => {
    expect(renderTargetsFor(rows('claude-code', 'zai'), []).agentTargets.map((t) => t.dir)).toEqual(
      ['.claude/agents'],
    );
    expect(renderTargetsFor(rows('amp'), []).agentTargets).toEqual([]);
    expect(renderTargetsFor(rows('amp'), [], { agentsFallback: true }).agentTargets).toEqual([
      FALLBACK_AGENT_TARGET,
    ]);
  });

  it('chooses the targets by origin', () => {
    const amp = rows('amp');
    expect(originAgentTargets({ from: 'blank' }, amp)).toEqual([]);
    expect(originAgentTargets({ from: 'column', lspLanguages: [] }, amp)).toEqual([
      FALLBACK_AGENT_TARGET,
    ]);
    expect(originAgentTargets({ from: 'column', agentTargets: [], lspLanguages: [] }, amp)).toEqual(
      [],
    );
    expect(originAgentTargets({ from: 'snapshot', lspLanguages: [] }, rows('codex'))).toEqual([
      { ...CODEX, supportsLsp: false },
    ]);
    expect(originAgentTargets({ from: 'onboarding', agentTargets: [CODEX] }, amp)).toEqual([CODEX]);
    expect(originAgentTargets({ from: 'onboarding' }, amp)).toEqual([FALLBACK_AGENT_TARGET]);
  });

  it('says whether a custom item renders at all', () => {
    expect(bundleItemRenders('agent', { agentTargets: [], skillDirs: ['.claude/skills'] })).toBe(
      false,
    );
    expect(bundleItemRenders('skill', { agentTargets: [CLAUDE], skillDirs: [] })).toBe(false);
    expect(bundleItemRenders('agent', { agentTargets: [CLAUDE], skillDirs: [] })).toBe(true);
    expect(bundleItemRenders('skill', { agentTargets: [], skillDirs: ['.claude/skills'] })).toBe(
      true,
    );
  });

  describe('rendersAt', () => {
    const targets = { agentTargets: [CLAUDE, GEMINI], skillDirs: ['.claude/skills'] };
    const at = (templateKind: string, templateId: string, diskPath: string, specId?: string) =>
      rendersAt({ templateKind, templateId, diskPath, specId }, targets);

    it('follows the agent targets for an agent and its index', () => {
      expect(at('agent', 'agent.x', '.claude/agents/x.md')).toBe(true);
      expect(at('agent', 'agent.x', '.codex/agents/x.toml')).toBe(false);
      expect(at('agent', 'agent.x', '.claude/agents/y.md')).toBe(false);
      expect(at('agents-index', 'agents-index', '.claude/agents/README.md')).toBe(true);
      expect(at('agents-index', 'agents-index', '.gemini/agents/README.md')).toBe(false);
    });

    it('follows the agent targets and skills directories for a custom item by its own id', () => {
      expect(at('custom-agent', 'custom.b.i', '.gemini/agents/a.md', 'a')).toBe(true);
      expect(at('custom-agent', 'custom.b.i', '.gemini/agents/i.md', 'a')).toBe(false);
      expect(at('custom-skill', 'custom.b.i', '.claude/skills/s/SKILL.md', 's')).toBe(true);
      expect(at('custom-skill', 'custom.b.i', '.claude/skills/s/sub-skills/p.md', 's')).toBe(true);
      expect(at('custom-skill', 'custom.b.i', '.agents/skills/s/SKILL.md', 's')).toBe(false);
    });

    it('takes every other kind as rendered where it stands', () => {
      expect(at('workflow-config', 'workflow-config', '.claude/workflow-config.json')).toBe(true);
      expect(at('cli-rules', 'cli-rules', 'AGENTS.md')).toBe(true);
    });
  });
});
