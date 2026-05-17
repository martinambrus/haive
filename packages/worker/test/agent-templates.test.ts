import { describe, expect, it } from 'vitest';
import {
  type AgentSpec,
  buildAgentFileForTarget,
  buildAgentFileMarkdown,
  buildAgentFileMarkdownGemini,
  shouldEmitAgentsReadme,
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

describe('buildAgentFileMarkdown body', () => {
  it('emits the 3-step KB → LSP → GREP search order block', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toContain('## Mandatory Search Order');
    expect(md).toContain('1. KB → 2. LSP → 3. GREP (last resort)');
    expect(md).toMatch(/1\. \*\*KB \(first\)\*\*/);
    expect(md).toMatch(/2\. \*\*LSP \(for code navigation\)\*\*/);
    expect(md).toMatch(/3\. \*\*GREP \(last resort\)\*\*/);
  });

  it('contains no RAG references in the search-order block', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    // The previous template injected a 4-step block referencing
    // .claude/rag/query.py — that script never ships with onboarding output
    // (RAG runs server-side under ragMode='internal' in the haive_rag_<project>
    // DB). Any leak of the old block sends agents to a dead path.
    expect(md).not.toMatch(/\bRAG\b/);
    expect(md).not.toContain('rag/query.py');
    expect(md).not.toContain('hybrid_score');
    expect(md).not.toContain('.claude/rag/');
  });

  it('keeps the kb-references frontmatter mention even with RAG removed', () => {
    // The KB-first instruction still tells agents to read kb-references — the
    // KB folder is the surviving knowledge surface that ships with onboarding.
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toContain('kb-references');
  });
});

describe('buildAgentFileMarkdownGemini frontmatter', () => {
  it('emits only name + description in frontmatter (no Claude-only keys)', () => {
    const md = buildAgentFileMarkdownGemini(baseSpec);
    expect(md).toMatch(
      /^---\nname: sample-agent\ndescription: Reviews things and reports findings\.\n---\n/,
    );
    expect(md).not.toContain('color:');
    expect(md).not.toContain('field:');
    expect(md).not.toContain('expertise:');
    expect(md).not.toContain('allowed-tools:');
    expect(md).not.toContain('auto-invoke:');
    expect(md).not.toContain('mcp-tools:');
    expect(md).not.toContain('kb-references:');
  });

  it('still emits the shared agent body (search order, mission, etc.)', () => {
    const md = buildAgentFileMarkdownGemini(baseSpec);
    expect(md).toContain('## Mandatory Search Order');
    expect(md).toContain('## Core Mission');
    expect(md).toContain('Find issues.');
  });
});

describe('buildAgentFileForTarget routing', () => {
  it('routes .gemini/agents to the gemini renderer', () => {
    const md = buildAgentFileForTarget(baseSpec, { dir: '.gemini/agents', format: 'markdown' });
    expect(md).not.toContain('color:');
    expect(md).not.toContain('allowed-tools:');
  });

  it('routes .claude/agents to the claude renderer', () => {
    const md = buildAgentFileForTarget(baseSpec, { dir: '.claude/agents', format: 'markdown' });
    expect(md).toContain('color: red');
    expect(md).toContain('allowed-tools: [Read, Grep, Bash]');
  });

  it('routes toml format to the codex TOML renderer', () => {
    const toml = buildAgentFileForTarget(baseSpec, { dir: '.codex/agents', format: 'toml' });
    expect(toml).toContain('name = "sample-agent"');
    expect(toml).toContain('description = ');
  });
});

describe('shouldEmitAgentsReadme', () => {
  it('skips README for .gemini/agents (gemini parses every .md as an agent)', () => {
    expect(shouldEmitAgentsReadme({ dir: '.gemini/agents' })).toBe(false);
  });

  it('emits README for .claude/agents and .codex/agents', () => {
    expect(shouldEmitAgentsReadme({ dir: '.claude/agents' })).toBe(true);
    expect(shouldEmitAgentsReadme({ dir: '.codex/agents' })).toBe(true);
  });
});
