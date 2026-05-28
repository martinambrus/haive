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

  it('always emits mcp-tools with rag_search so RAG-first is callable', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toContain('mcp-tools: [rag_search]');
  });

  it('merges rag_search with agent-specific mcp tools', () => {
    const md = buildAgentFileMarkdown({ ...baseSpec, mcpTools: ['chrome-devtools'] });
    expect(md).toContain('mcp-tools: [rag_search, chrome-devtools]');
  });
});

describe('buildAgentFileMarkdown body', () => {
  it('emits the 4-step RAG → KB → LSP → GREP search order block', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toContain('## Mandatory Search Order');
    expect(md).toContain('1. RAG → 2. KB → 3. LSP → 4. GREP (last resort)');
    expect(md).toMatch(/1\. \*\*RAG \(first\)\*\*/);
    expect(md).toMatch(/2\. \*\*KB\*\*/);
    expect(md).toMatch(/3\. \*\*LSP \(for code navigation\)\*\*/);
    expect(md).toMatch(/4\. \*\*GREP \(last resort\)\*\*/);
  });

  it('directs agents to the rag_search MCP tool first', () => {
    const md = buildAgentFileMarkdown(baseSpec);
    expect(md).toContain('`rag_search`');
    // The retrieval path is the server-side MCP tool, never the old shipped
    // script. Guard against the dead .claude/rag/query.py block resurfacing.
    expect(md).not.toContain('rag/query.py');
    expect(md).not.toContain('hybrid_score');
    expect(md).not.toContain('.claude/rag/');
  });

  it('keeps the kb-references frontmatter mention', () => {
    // The KB step still tells agents to read kb-references — the KB folder is a
    // knowledge surface that ships with onboarding.
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
