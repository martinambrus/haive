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
