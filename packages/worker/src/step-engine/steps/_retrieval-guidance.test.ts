import { describe, expect, it } from 'vitest';
import {
  adaptPromptForCliCapabilities,
  adaptRetrievalProtocol,
  agentDefinitionGuidance,
  agentGuidanceIds,
  ddevConfigGuidanceLines,
  buildRetrievalGuidance,
  retrievalGuidanceLines,
  retrievalGuidanceLinesFor,
  type RetrievalAxes,
} from './_retrieval-guidance.js';

describe('agentGuidanceIds', () => {
  it('reads every marker id once, in code-unit order, and nothing from prose', () => {
    const prompt = [
      'intro',
      agentDefinitionGuidance('test-writer', 'Read .claude/agents/test-writer.md first.'),
      'prose that mentions .claude/agents/peer-reviewer.md is not an assignment',
      agentDefinitionGuidance('code-reviewer', 'See .claude/agents/code-reviewer.md.'),
      agentDefinitionGuidance('test-writer', 'Again .claude/agents/test-writer.md.'),
    ].join('\n');
    expect(agentGuidanceIds(prompt)).toEqual(['code-reviewer', 'test-writer']);
    expect(agentGuidanceIds('no marker here')).toEqual([]);
  });

  it('finds nothing in a prompt the rewrite has already processed, on either arm', () => {
    const prompt = agentDefinitionGuidance('test-writer', 'Read .claude/agents/test-writer.md.');
    const fallback = adaptPromptForCliCapabilities(prompt, {
      supportsLsp: false,
      ragWired: false,
      projectAgentsDir: null,
      agentFileFormat: null,
    });
    const pointer = adaptPromptForCliCapabilities(prompt, {
      supportsLsp: true,
      ragWired: true,
      projectAgentsDir: '.grok/agents',
      agentFileFormat: 'markdown',
    });
    expect(agentGuidanceIds(fallback)).toEqual([]);
    expect(pointer).toContain('.grok/agents/test-writer.md');
    expect(agentGuidanceIds(pointer)).toEqual([]);
  });
});

const AXES: RetrievalAxes[] = [
  { supportsLsp: true, ragWired: true },
  { supportsLsp: true, ragWired: false },
  { supportsLsp: false, ragWired: true },
  { supportsLsp: false, ragWired: false },
];

describe('adaptPromptForCliCapabilities under isolation', () => {
  const CAPABLE = {
    supportsLsp: true,
    ragWired: true,
    projectAgentsDir: '.claude/agents',
    agentFileFormat: 'markdown' as const,
  };
  const marked = (id: string): string =>
    agentDefinitionGuidance(id, `Follow .claude/agents/${id}.md if it exists.`);

  it('pastes the body behind the label, and drops the pointer path', () => {
    const out = adaptPromptForCliCapabilities(marked('peer-reviewer'), {
      ...CAPABLE,
      isolated: true,
      agentBodies: { 'peer-reviewer': '# Peer reviewer\n\nScore every dimension.' },
    });
    expect(out).toContain('[[HAIVE_PASTED_PERSONA:peer-reviewer]]');
    expect(out).toContain('Score every dimension.');
    expect(out).toContain('takes precedence over the embedded protocol');
    // The file will be masked, so the prompt must not send the agent at it.
    expect(out).not.toContain('.claude/agents/peer-reviewer.md');
  });

  it('falls back to the embedded protocol when no body was read', () => {
    // The COMMON case for two ids with no onboarding template: simplicity-reviewer, knowledge-curator.
    const out = adaptPromptForCliCapabilities(marked('simplicity-reviewer'), {
      ...CAPABLE,
      isolated: true,
      agentBodies: {},
    });
    expect(out).toBe('Follow the embedded protocol below.');
  });

  it('carries a body containing $& verbatim', () => {
    // The reason the isolated arm builds its string instead of calling `guidance.replace(ptr, body)`:
    // a `$&` in a replacement STRING expands to the matched text, putting the pointer path — and the
    // marker around it — back into a prompt the path scan already cleared.
    const body = "Never write $& or $` or $' in a report.";
    const out = adaptPromptForCliCapabilities(marked('peer-reviewer'), {
      ...CAPABLE,
      isolated: true,
      agentBodies: { 'peer-reviewer': body },
    });
    expect(out).toContain(body);
    expect(out).not.toContain('.claude/agents/peer-reviewer.md');
    expect(out).not.toContain('HAIVE_AGENT_DEFINITION');
  });

  it('leaves the pointer arm exactly as it is when isolation is off', () => {
    const prompt = marked('peer-reviewer');
    const off = adaptPromptForCliCapabilities(prompt, CAPABLE);
    const explicit = adaptPromptForCliCapabilities(prompt, { ...CAPABLE, isolated: false });
    expect(off).toContain('.claude/agents/peer-reviewer.md');
    expect(off).not.toContain('HAIVE_PASTED_PERSONA');
    expect(explicit).toBe(off);
  });

  it('ignores bodies on a provider that does not pass the pointer gate', () => {
    // Outside the four-condition gate the prompt is unchanged today, so isolation pastes nothing
    // there either — the fallback line is what such a provider already got.
    const out = adaptPromptForCliCapabilities(marked('peer-reviewer'), {
      ...CAPABLE,
      supportsLsp: false,
      isolated: true,
      agentBodies: { 'peer-reviewer': 'a body' },
    });
    expect(out).toBe('Follow the embedded protocol below.');
  });
});

describe('buildRetrievalGuidance', () => {
  // Six splice sites join with `.filter(Boolean)` and nine without. An empty element would
  // therefore render the "same" block two different ways, and the dispatch-time replaceAll
  // would match only one of them — half the prompts silently keeping the wrong arm.
  it('emits no empty line in any variant', () => {
    for (const axes of AXES) {
      expect(buildRetrievalGuidance(axes).every((line) => line.length > 0)).toBe(true);
    }
  });

  it('starts every variant at 1. so it drops into a caller-numbered list', () => {
    for (const axes of AXES) {
      expect(buildRetrievalGuidance(axes)[0]?.startsWith('1. ')).toBe(true);
    }
  });

  it('never names rag_search in a rag-off variant', () => {
    for (const axes of AXES.filter((a) => !a.ragWired)) {
      expect(buildRetrievalGuidance(axes).join('\n')).not.toContain('rag_search');
    }
  });

  it('never names LSP in a no-LSP variant', () => {
    for (const axes of AXES.filter((a) => !a.supportsLsp)) {
      expect(buildRetrievalGuidance(axes).join('\n')).not.toContain('LSP');
    }
  });

  it('keeps discovery and grounding as separate steps in every variant', () => {
    for (const axes of AXES) {
      const text = buildRetrievalGuidance(axes).join('\n');
      expect(text).toContain('GROUND every lead');
      expect(text).toMatch(axes.ragWired ? /DISCOVER with `rag_search`/ : /LOCATE with/);
    }
  });

  it('renders the canonical arm for prompt builders', () => {
    expect(retrievalGuidanceLines()).toEqual(
      buildRetrievalGuidance({ supportsLsp: true, ragWired: true }),
    );
  });

  // Agent definition files outlive any one run and cannot know a future task's rag mode,
  // so they render the rag-on arm; the surface block contradicts them when it is absent.
  it('renders the rag-on arm for the agent file writers', () => {
    for (const supportsLsp of [true, false]) {
      expect(retrievalGuidanceLinesFor(supportsLsp)).toEqual(
        buildRetrievalGuidance({ supportsLsp, ragWired: true }),
      );
    }
  });
});

describe('adaptRetrievalProtocol', () => {
  const canonical = retrievalGuidanceLines().join('\n');

  it('leaves the canonical arm untouched', () => {
    const prompt = `before\n${canonical}\nafter`;
    expect(adaptRetrievalProtocol(prompt, { supportsLsp: true, ragWired: true })).toBe(prompt);
  });

  it.each(AXES.slice(1))('rewrites the canonical arm for %o', (axes) => {
    const prompt = `before\n${canonical}\nafter`;
    const adapted = adaptRetrievalProtocol(prompt, axes);
    expect(adapted).toBe(`before\n${buildRetrievalGuidance(axes).join('\n')}\nafter`);
  });

  // The old implementation returned early whenever LSP was on, so this cell was skipped —
  // and it is a live one: every claude-family provider on a repo with `ragMode: 'none'`.
  it('rewrites for an LSP-capable provider whose repo has no index', () => {
    const adapted = adaptRetrievalProtocol(canonical, { supportsLsp: true, ragWired: false });
    expect(adapted).not.toContain('rag_search');
    expect(adapted).toContain('LOCATE with LSP + grep');
  });

  it('rewrites every occurrence, not just the first', () => {
    const prompt = [canonical, 'middle', canonical].join('\n');
    const axes = { supportsLsp: false, ragWired: false };
    const adapted = adaptRetrievalProtocol(prompt, axes);
    expect(adapted.split(buildRetrievalGuidance(axes).join('\n'))).toHaveLength(3);
  });

  it('leaves surrounding prose alone', () => {
    const prompt = 'The task may legitimately discuss LSP and rag_search architecture.';
    expect(adaptRetrievalProtocol(prompt, { supportsLsp: false, ragWired: false })).toBe(prompt);
  });
});

describe('ddevConfigGuidanceLines', () => {
  it('emits the rule when the work mentions DDEV', () => {
    const lines = ddevConfigGuidanceLines('Add DDEV to this Drupal site');
    expect(lines.join('\n')).toContain('ddev_version_constraint');
    expect(lines.join('\n')).toContain('>= v1.24.0 < v2.0.0');
  });

  it('matches case-insensitively', () => {
    expect(ddevConfigGuidanceLines('add ddev').length).toBeGreaterThan(0);
    expect(ddevConfigGuidanceLines('Configure DDev locally').length).toBeGreaterThan(0);
  });

  it('stays out of prompts that have nothing to do with DDEV', () => {
    // The lines are pure prompt weight for such a task, and the runtime repair in
    // sandbox/ddev-version-constraint.ts is what actually guarantees the outcome.
    expect(ddevConfigGuidanceLines('Add a logout button to the header')).toEqual([]);
    expect(ddevConfigGuidanceLines('')).toEqual([]);
  });

  it('does not fire on a word that merely contains "ddev"', () => {
    expect(ddevConfigGuidanceLines('refactor the middevice adapter')).toEqual([]);
  });
});
