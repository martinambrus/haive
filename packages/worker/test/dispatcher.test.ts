import { describe, expect, it } from 'vitest';
import { resolveDispatch } from '../src/orchestrator/dispatcher.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderRecord, SubAgentSpec } from '../src/cli-adapters/types.js';
import {
  agentDefinitionGuidance,
  retrievalGuidanceLines,
} from '../src/step-engine/steps/_retrieval-guidance.js';

type ProviderOverrides = Partial<CliProviderRecord> & Pick<CliProviderRecord, 'id' | 'name'>;

function makeProvider(overrides: ProviderOverrides): CliProviderRecord {
  const now = new Date();
  return {
    id: overrides.id,
    userId: overrides.userId ?? 'user-1',
    name: overrides.name,
    label: overrides.label ?? `${overrides.name} label`,
    executablePath: overrides.executablePath ?? null,
    wrapperPath: overrides.wrapperPath ?? null,
    envVars: overrides.envVars ?? null,
    cliArgs: overrides.cliArgs ?? null,
    supportsSubagents: overrides.supportsSubagents ?? false,
    authMode: overrides.authMode ?? 'subscription',
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  } as CliProviderRecord;
}

const sampleSubAgentSpec: SubAgentSpec = {
  subAgents: [
    { name: 'detector', prompt: 'Detect project type', outputKey: 'detect' },
    { name: 'analyzer', prompt: 'Analyze detect output', outputKey: 'analysis' },
  ],
  synthesisPrompt: 'Summarize results',
};

describe('resolveDispatch', () => {
  it('returns skip when there are no enabled providers', () => {
    const plan = resolveDispatch({
      providers: [],
      input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toBe('no enabled cli providers');
  });

  it('picks the preferred provider first when set', () => {
    const claude = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      supportsSubagents: true,
    });
    const codex = makeProvider({
      id: 'prov-codex',
      name: 'codex',
    });
    const plan = resolveDispatch({
      providers: [codex, claude],
      preferredProviderId: 'prov-claude',
      input: { kind: 'prompt', prompt: 'hello', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.providerId).toBe('prov-claude');
    expect(plan.mode).toBe('cli');
    expect(plan.reason).toBe('cli');
  });

  it('emits a native sub-agent invocation for claude-code', () => {
    const provider = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      supportsSubagents: true,
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'subagent', spec: sampleSubAgentSpec, capabilities: ['subagents'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('cli');
    expect(plan.reason).toBe('native_subagents');
    expect(plan.invocation?.kind).toBe('subagent');
    if (plan.invocation?.kind === 'subagent') {
      expect(plan.invocation.spec.mode).toBe('native');
      expect(plan.invocation.spec.steps).toHaveLength(2);
    }
  });

  it('emits a sequential sub-agent invocation for codex', () => {
    const provider = makeProvider({
      id: 'prov-codex',
      name: 'codex',
      supportsSubagents: false,
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'subagent', spec: sampleSubAgentSpec, capabilities: ['subagents'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('subagent_emulated');
    expect(plan.reason).toBe('sequential_emulation');
    if (plan.invocation?.kind === 'subagent') {
      expect(plan.invocation.spec.mode).toBe('sequential');
      expect(plan.invocation.spec.steps).toHaveLength(2);
    }
  });

  it('routes api_key providers through the CLI binary so tools are available', () => {
    const zai = makeProvider({
      id: 'prov-zai',
      name: 'zai',
      authMode: 'api_key',
    });
    const plan = resolveDispatch({
      providers: [zai],
      input: { kind: 'prompt', prompt: 'scan repo', capabilities: ['tool_use'] },
      invokeOpts: {},
    });
    expect(plan.providerId).toBe('prov-zai');
    expect(plan.mode).toBe('cli');
    expect(plan.reason).toBe('cli');
    expect(plan.invocation?.kind).toBe('cli');
  });

  it('skips disabled providers entirely', () => {
    const provider = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      enabled: false,
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt: 'hi', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
  });

  it('builds a CliCommandSpec using the resolved executable', () => {
    const provider = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      executablePath: '/usr/local/bin/claude',
    });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt: 'status?', capabilities: [] },
      invokeOpts: { cwd: '/repo' },
      registry: cliAdapterRegistry,
    });
    expect(plan.mode).toBe('cli');
    if (plan.invocation?.kind === 'cli') {
      expect(plan.invocation.spec.command).toBe('/usr/local/bin/claude');
      expect(plan.invocation.spec.args).toContain('status?');
      expect(plan.invocation.spec.cwd).toBe('/repo');
    }
  });

  it('removes every Haive-owned LSP instruction for Codex and preserves unrelated prompt text', () => {
    const provider = makeProvider({ id: 'prov-codex', name: 'codex' });
    const guidance = retrievalGuidanceLines().join('\n');
    const prompt = [
      'PREFIX: keep this byte-for-byte.',
      guidance,
      'MIDDLE: the task itself may legitimately discuss LSP architecture.',
      guidance,
      'Then GROUND every lead with LSP + grep against the CURRENT files on disk (on hits too, not as a fallback): the index can be stale, so a rag_search snippet is a lead to confirm, never the source of truth.',
      'Validate (rag_search, then ground with LSP + grep).',
      'Sweep renamed calls (grep -rn / find-references).',
      agentDefinitionGuidance(
        'spec-quality-reviewer',
        [
          'If a `.claude/agents/spec-quality-reviewer.md` agent definition exists in the repo, follow it;',
          'otherwise follow the protocol below.',
        ].join('\n'),
      ),
      'SUFFIX: keep this too.',
    ].join('\n');
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt, capabilities: [] },
      invokeOpts: {},
    });
    const effective = plan.effectivePrompt!;
    expect(effective.startsWith('PREFIX: keep this byte-for-byte.')).toBe(true);
    expect(effective.endsWith('SUFFIX: keep this too.')).toBe(true);
    expect(effective).toContain('the task itself may legitimately discuss LSP architecture');
    expect(effective).not.toContain('LSP + grep');
    expect(effective).not.toContain('find-references');
    expect(effective).not.toContain('.claude/agents/spec-quality-reviewer.md');
    expect(effective).not.toContain('HAIVE_AGENT_DEFINITION');
    expect(effective.match(/grep \+ direct file reads/g)).toHaveLength(6);
    expect(effective).toContain('Follow the embedded protocol below.');
    if (plan.invocation?.kind === 'cli') {
      expect(plan.invocation.spec.args.at(-1)).toBe(effective);
    }
  });

  it('keeps LSP guidance and resolves the native agent path for a capable provider', () => {
    const provider = makeProvider({ id: 'prov-claude', name: 'claude-code' });
    const agentClause = [
      'If a `.claude/agents/spec-quality-reviewer.md` agent definition exists in the repo, follow it;',
      'otherwise follow the protocol below.',
    ].join('\n');
    const prompt = [
      'before',
      retrievalGuidanceLines().join('\n'),
      agentDefinitionGuidance('spec-quality-reviewer', agentClause),
      'after',
    ].join('\n');
    const plan = resolveDispatch({
      providers: [provider],
      lspConfigured: true,
      input: { kind: 'prompt', prompt, capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).toBe(
      ['before', retrievalGuidanceLines().join('\n'), agentClause, 'after'].join('\n'),
    );
  });

  it('adapts every emulated subagent and synthesis prompt for Codex', () => {
    const provider = makeProvider({
      id: 'prov-codex',
      name: 'codex',
      supportsSubagents: false,
    });
    const lspPrompt = retrievalGuidanceLines().join('\n');
    const plan = resolveDispatch({
      providers: [provider],
      input: {
        kind: 'subagent',
        spec: {
          subAgents: [{ name: 'reviewer', prompt: lspPrompt, outputKey: 'review' }],
          synthesisPrompt: `Synthesize\n${lspPrompt}`,
        },
        capabilities: ['subagents'],
      },
      invokeOpts: {},
    });
    expect(plan.invocation?.kind).toBe('subagent');
    if (plan.invocation?.kind === 'subagent') {
      expect(plan.invocation.spec.steps[0]?.prompt).not.toContain('LSP + grep');
      expect(plan.invocation.spec.synthesis.prompt).not.toContain('LSP + grep');
      expect(plan.invocation.spec.steps[0]?.prompt).toContain('grep + direct file reads');
    }
  });

  it('resolves marked agent guidance in capable-provider subagents too', () => {
    const provider = makeProvider({ id: 'prov-claude', name: 'claude-code' });
    const marked = agentDefinitionGuidance(
      'spec-quality-reviewer',
      [
        'If a `.claude/agents/spec-quality-reviewer.md` agent definition exists in the repo, follow it;',
        'otherwise follow the protocol below.',
      ].join('\n'),
    );
    const plan = resolveDispatch({
      providers: [provider],
      lspConfigured: true,
      input: {
        kind: 'subagent',
        spec: {
          subAgents: [{ name: 'reviewer', prompt: marked, outputKey: 'review' }],
          synthesisPrompt: marked,
        },
        capabilities: ['subagents'],
      },
      invokeOpts: {},
    });
    expect(plan.invocation?.kind).toBe('subagent');
    if (plan.invocation?.kind === 'subagent') {
      expect(plan.invocation.spec.steps[0]?.prompt).toContain(
        '.claude/agents/spec-quality-reviewer.md',
      );
      expect(plan.invocation.spec.steps[0]?.prompt).not.toContain('HAIVE_AGENT_DEFINITION');
      expect(plan.invocation.spec.synthesis.prompt).not.toContain('HAIVE_AGENT_DEFINITION');
    }
  });

  it('removes LSP guidance for a capable provider when no usable server bridge is configured', () => {
    const provider = makeProvider({ id: 'prov-claude', name: 'claude-code' });
    const prompt = [
      retrievalGuidanceLines().join('\n'),
      agentDefinitionGuidance(
        'spec-quality-reviewer',
        'Follow `.claude/agents/spec-quality-reviewer.md`.',
      ),
    ].join('\n');
    const plan = resolveDispatch({
      providers: [provider],
      lspConfigured: false,
      input: { kind: 'prompt', prompt, capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).toContain('grep + direct file reads');
    expect(plan.effectivePrompt).not.toContain('LSP + grep');
    expect(plan.effectivePrompt).not.toContain('.claude/agents/spec-quality-reviewer.md');
  });
});
