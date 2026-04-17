import { describe, expect, it } from 'vitest';
import {
  type AgentSpec,
  buildAgentFileMarkdown,
} from '../src/step-engine/steps/onboarding/_agent-templates.js';

const baseSpec: AgentSpec = {
  id: 'sample-agent',
  title: 'Sample Agent',
  description: 'Reviews things and reports findings.',
  color: 'red',
  field: 'quality',
  tools: ['Read', 'Grep', 'Bash'],
  coreMission: 'Find issues.',
  responsibilities: ['Look hard.'],
  whenInvoked: ['Before merge.'],
  executionSteps: [{ title: 'Look', body: 'Read every file you can.' }],
  outputFormat: '```\nfindings: []\n```',
  qualityCriteria: ['No false positives.'],
  antiPatterns: ['Skip the security pass.'],
};

describe('buildAgentFileMarkdown frontmatter', () => {
  it('emits the Claude Code allowed-tools field, not "tools"', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('allowed-tools: [Read, Grep, Bash]');
    expect(md).not.toMatch(/^tools:/m);
  });

  it('defaults model to opus and expertise to expert when unspecified', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toContain('model: opus');
    expect(md).toContain('expertise: expert');
  });

  it('honours explicit model and expertise overrides', () => {
    const md = buildAgentFileMarkdown({ ...baseSpec, model: 'sonnet', expertise: 'senior' });
    expect(md).toContain('model: sonnet');
    expect(md).toContain('expertise: senior');
  });

  it('emits kb-references with patterns, standards and reference (no antipatterns key)', () => {
    const md = buildAgentFileMarkdown({
      ...baseSpec,
      kbReferences: {
        patterns: '.claude/knowledge_base/TECH_PATTERNS/foo/',
        standards: '.claude/knowledge_base/STANDARDS/foo.md',
        reference: '.claude/knowledge_base/QUICK_REFERENCE/foo.md',
      },
    });
    expect(md).toContain('kb-references:');
    expect(md).toContain('  patterns: .claude/knowledge_base/TECH_PATTERNS/foo/');
    expect(md).toContain('  standards: .claude/knowledge_base/STANDARDS/foo.md');
    expect(md).toContain('  reference: .claude/knowledge_base/QUICK_REFERENCE/foo.md');
    expect(md).not.toMatch(/^\s*antipatterns:/m);
  });

  it('omits the kb-references block entirely when no refs are provided', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).not.toContain('kb-references:');
  });

  it('keeps name, description, color, field, auto-invoke fields intact', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toContain('name: sample-agent');
    expect(md).toContain('description: Reviews things and reports findings.');
    expect(md).toContain('color: red');
    expect(md).toContain('field: quality');
    expect(md).toContain('auto-invoke: false');
  });
});
