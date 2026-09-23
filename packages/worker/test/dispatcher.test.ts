import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { resolveDispatch, resolveTaskDispatch } from '../src/orchestrator/dispatcher.js';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderRecord, SubAgentSpec } from '../src/cli-adapters/types.js';
import {
  agentDefinitionGuidance,
  buildRetrievalGuidance,
  retrievalGuidanceLines,
} from '../src/step-engine/steps/_retrieval-guidance.js';
import { WORKTREE_GIT_BOUNDARY_MARKER } from '../src/repo/worktree-git-boundary.js';
import { mcpSurfacePrompt, type McpSurface } from '../src/sandbox/mcp-surface.js';
import { DEFAULT_AGENT_RULES } from '@haive/shared';
import { AGENT_RULES_MARKER, agentRulesHash } from '../src/orchestrator/agent-rules.js';
import {
  PROMPT_ARGV_LIMIT_BYTES,
  PromptTooLargeError,
} from '../src/cli-adapters/prompt-delivery.js';

function surface(ragEnabled: boolean): McpSurface {
  return {
    ragOnly: false,
    rag: { enabled: ragEnabled, apiUrl: 'http://api:3001', token: 't' },
    chromeDevtools: { enabled: false, version: null },
    ddevControl: { enabled: false, apiUrl: '', token: '' },
    userServers: {},
  };
}

/** What every prompt now carries ahead of its own text. Composed here rather than pasted
 *  so the byte-exact assertions below keep testing the dispatcher's own transforms and
 *  not the wording of the surface block. A test that means to exercise the LSP axis must
 *  pass a rag-enabled surface, or it exercises the rag axis by omission. */
const NO_MCP = `${mcpSurfacePrompt(null)}\n\n`;
const RAG_ON = `${mcpSurfacePrompt(surface(true))}\n\n`;

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

  it('stamps the personas a prompt carries as markers onto the spec, read before the rewrite', () => {
    const provider = makeProvider({ id: 'prov-claude', name: 'claude-code' });
    const prompt = [
      agentDefinitionGuidance('test-writer', 'Read .claude/agents/test-writer.md first.'),
      'do the work',
      agentDefinitionGuidance('code-reviewer', 'See .claude/agents/code-reviewer.md.'),
    ].join('\n');
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt, capabilities: [] },
      invokeOpts: {},
      // An explicit id (a mining persona) unions with the markers; a duplicate collapses.
      assignedAgentIds: ['drupal7-developer', 'test-writer'],
    });
    expect(plan.invocation?.kind).toBe('cli');
    const spec = plan.invocation?.kind === 'cli' ? plan.invocation.spec : null;
    expect(spec?.assignedAgentIds).toEqual(['code-reviewer', 'drupal7-developer', 'test-writer']);
    // The stored prompt is the rewritten one and carries no marker to recover them from.
    expect(plan.effectivePrompt).not.toContain('HAIVE_AGENT_DEFINITION');
  });

  it('leaves assignedAgentIds absent when nothing was assigned', () => {
    const provider = makeProvider({ id: 'prov-claude', name: 'claude-code' });
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt: 'plain work', capabilities: [] },
      invokeOpts: {},
    });
    const spec = plan.invocation?.kind === 'cli' ? plan.invocation.spec : null;
    expect(spec).not.toBeNull();
    expect('assignedAgentIds' in (spec ?? {})).toBe(false);
  });

  it('carries the union of every sub-agent prompt on a sub-agent invocation', () => {
    const provider = makeProvider({
      id: 'prov-claude',
      name: 'claude-code',
      supportsSubagents: true,
    });
    const spec: SubAgentSpec = {
      subAgents: [
        {
          name: 'writer',
          prompt: agentDefinitionGuidance('test-writer', 'Read .claude/agents/test-writer.md.'),
          outputKey: 'writer',
        },
        { name: 'plain', prompt: 'no persona', outputKey: 'plain' },
      ],
      synthesisPrompt: agentDefinitionGuidance(
        'code-reviewer',
        'See .claude/agents/code-reviewer.md.',
      ),
    };
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'subagent', spec, capabilities: ['subagents'] },
      invokeOpts: {},
    });
    const invocation = plan.invocation?.kind === 'subagent' ? plan.invocation.spec : null;
    expect(invocation?.assignedAgentIds).toEqual(['code-reviewer', 'test-writer']);
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
      expect(plan.invocation.spec.args).toContain(`${NO_MCP}status?`);
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
      mcpSurface: surface(true),
      invokeOpts: {},
    });
    const effective = plan.effectivePrompt!;
    expect(effective.startsWith(`${RAG_ON}PREFIX: keep this byte-for-byte.`)).toBe(true);
    expect(effective.endsWith('SUFFIX: keep this too.')).toBe(true);
    expect(effective).toContain('the task itself may legitimately discuss LSP architecture');
    expect(effective).not.toContain('LSP + grep');
    expect(effective).not.toContain('find-references');
    expect(effective).not.toContain('.claude/agents/spec-quality-reviewer.md');
    expect(effective).not.toContain('HAIVE_AGENT_DEFINITION');
    // Asserted against the builder rather than an occurrence count: a magic number here
    // rots the next time either axis changes, and rots silently.
    expect(effective).toContain(
      buildRetrievalGuidance({ supportsLsp: false, ragWired: true }).join('\n'),
    );
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
      mcpSurface: surface(true),
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).toBe(
      RAG_ON + ['before', retrievalGuidanceLines().join('\n'), agentClause, 'after'].join('\n'),
    );
  });

  it('drops the rag arm — and the agent-file pointer stays — when no rag server is wired', () => {
    const provider = makeProvider({ id: 'prov-claude', name: 'claude-code' });
    const plan = resolveDispatch({
      providers: [provider],
      lspConfigured: true,
      input: { kind: 'prompt', prompt: retrievalGuidanceLines().join('\n'), capabilities: [] },
      mcpSurface: surface(false),
      invokeOpts: {},
    });
    const effective = plan.effectivePrompt!;
    expect(effective).toContain(
      buildRetrievalGuidance({ supportsLsp: true, ragWired: false }).join('\n'),
    );
    expect(effective).toContain('LOCATE with LSP + grep');
    // The only `rag_search` left is the surface block saying the tool is absent.
    expect(effective).not.toContain('DISCOVER with `rag_search`');
    expect(effective).toContain('No `rag_search` (haive-rag) tool is wired into this run');
  });

  it('composes both axes — codex on a repo with no index gets the grep-only protocol', () => {
    const plan = resolveDispatch({
      providers: [makeProvider({ id: 'prov-codex', name: 'codex' })],
      input: { kind: 'prompt', prompt: retrievalGuidanceLines().join('\n'), capabilities: [] },
      mcpSurface: surface(false),
      invokeOpts: {},
    });
    const effective = plan.effectivePrompt!;
    expect(effective).toContain(
      buildRetrievalGuidance({ supportsLsp: false, ragWired: false }).join('\n'),
    );
    expect(effective).toContain('LOCATE with grep / ripgrep');
    expect(effective).not.toContain('DISCOVER with `rag_search`');
    expect(effective).not.toContain('LSP');
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
      mcpSurface: surface(true),
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
      mcpSurface: surface(true),
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).toContain('grep + direct file reads');
    expect(plan.effectivePrompt).not.toContain('LSP + grep');
    expect(plan.effectivePrompt).not.toContain('.claude/agents/spec-quality-reviewer.md');
  });

  it('explains the zero-byte gitfile before serializing a masked-worktree prompt', () => {
    const provider = makeProvider({ id: 'prov-codex', name: 'codex' });
    const plan = resolveDispatch({
      providers: [provider],
      worktreeGitBoundary: true,
      input: { kind: 'prompt', prompt: 'Implement the issue.', capabilities: ['file_write'] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).toContain(WORKTREE_GIT_BOUNDARY_MARKER);
    expect(plan.effectivePrompt).toContain('zero-byte, read-only file');
    expect(plan.effectivePrompt).toContain('not repository corruption');
    if (plan.invocation?.kind === 'cli') {
      expect(plan.invocation.spec.args.at(-1)).toBe(plan.effectivePrompt);
    }
  });

  it('does not add the worktree boundary to a repo-root prompt', () => {
    const provider = makeProvider({ id: 'prov-codex', name: 'codex' });
    const plan = resolveDispatch({
      providers: [provider],
      worktreeGitBoundary: false,
      input: { kind: 'prompt', prompt: 'Inspect the repository.', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).toBe(`${NO_MCP}Inspect the repository.`);
  });

  it('adds the boundary to every worktree-bound subagent and synthesis prompt', () => {
    const provider = makeProvider({
      id: 'prov-codex',
      name: 'codex',
      supportsSubagents: false,
    });
    const plan = resolveDispatch({
      providers: [provider],
      worktreeGitBoundary: true,
      input: { kind: 'subagent', spec: sampleSubAgentSpec, capabilities: ['subagents'] },
      invokeOpts: {},
    });
    expect(plan.invocation?.kind).toBe('subagent');
    if (plan.invocation?.kind === 'subagent') {
      for (const step of plan.invocation.spec.steps) {
        expect(step.prompt).toContain(WORKTREE_GIT_BOUNDARY_MARKER);
      }
      expect(plan.invocation.spec.synthesis.prompt).toContain(WORKTREE_GIT_BOUNDARY_MARKER);
    }
  });

  it('derives the production boundary from the same task target as the mount', async () => {
    const task = {
      envTemplateId: null,
      repositoryId: 'repo-1',
      worktreeBranch: 'feature/x',
    };
    const db = {
      query: {
        tasks: { findFirst: async () => task },
        repositories: {
          findFirst: async () => ({ storagePath: null, localPath: null }),
        },
        // resolveTaskDispatch also resolves the MCP surface for the prompt block.
        taskSteps: { findFirst: async () => undefined },
        envTemplates: { findFirst: async () => undefined },
      },
      // Repo-level fallback for the step-04 tooling output (ragMode / mcp_settings).
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
          }),
        }),
      }),
    } as unknown as Database;
    const provider = makeProvider({ id: 'prov-codex', name: 'codex' });
    const worktreePlan = await resolveTaskDispatch(db, 'task-1', {
      providers: [provider],
      input: { kind: 'prompt', prompt: 'Worktree task.', capabilities: [] },
      invokeOpts: {},
    });
    expect(worktreePlan.effectivePrompt).toContain(WORKTREE_GIT_BOUNDARY_MARKER);

    const repoRootPlan = await resolveTaskDispatch(db, 'task-1', {
      providers: [provider],
      worktreeRel: '',
      input: { kind: 'prompt', prompt: 'Repo-root task.', capabilities: [] },
      invokeOpts: {},
    });
    expect(repoRootPlan.effectivePrompt).toBe(`${NO_MCP}Repo-root task.`);
  });
});

describe('global KB digest', () => {
  const digest = [
    { title: 'DDEV post-start hooks cannot inject settings', category: 'tech_pattern' },
  ];

  it('advertises the titles when the rag server is wired', () => {
    const plan = resolveDispatch({
      providers: [makeProvider({ id: 'prov-claude', name: 'claude-code' })],
      mcpSurface: surface(true),
      globalKbDigest: digest,
      input: { kind: 'prompt', prompt: 'Add DDEV.', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).toContain('DDEV post-start hooks cannot inject settings');
    expect(plan.effectivePrompt).toContain('rag_search');
  });

  it('advertises nothing when the rag server is not wired', () => {
    const plan = resolveDispatch({
      providers: [makeProvider({ id: 'prov-claude', name: 'claude-code' })],
      mcpSurface: surface(false),
      globalKbDigest: digest,
      input: { kind: 'prompt', prompt: 'Add DDEV.', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).not.toContain('DDEV post-start hooks cannot inject settings');
  });

  it('advertises nothing to an adapter that gets no MCP config at all', () => {
    const plan = resolveDispatch({
      providers: [makeProvider({ id: 'prov-amp', name: 'amp' })],
      mcpSurface: surface(true),
      globalKbDigest: digest,
      input: { kind: 'prompt', prompt: 'Add DDEV.', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).not.toContain('DDEV post-start hooks cannot inject settings');
  });

  it('leaves the prompt untouched when the digest is empty', () => {
    const plan = resolveDispatch({
      providers: [makeProvider({ id: 'prov-claude', name: 'claude-code' })],
      mcpSurface: surface(true),
      globalKbDigest: [],
      input: { kind: 'prompt', prompt: 'Add DDEV.', capabilities: [] },
      invokeOpts: {},
    });
    expect(plan.effectivePrompt).not.toContain('haive_global_kb_index');
  });
});

describe('vision', () => {
  // makeProvider builds a fixed literal and does not carry model/modelLimits, so
  // they are attached here rather than by widening the shared helper.
  const withModel = (
    provider: CliProviderRecord,
    model: string,
    modelLimits: CliProviderRecord['modelLimits'] = null,
  ): CliProviderRecord => ({ ...provider, model, modelLimits });

  const blind = (id: string, name: 'claude-code' | 'codex' = 'codex'): CliProviderRecord =>
    withModel(makeProvider({ id, name }), 'deepseek-v4-flash:cloud', {
      // What a live `400 does not support image input` taught us, keyed to the
      // model it was learned for.
      model: 'deepseek-v4-flash:cloud',
      vision: false,
      learnedAt: '2026-01-01',
    });

  const sighted = (id: string): CliProviderRecord =>
    withModel(makeProvider({ id, name: 'claude-code' }), 'claude-opus-5');

  it('skips a provider whose model has already rejected an image', () => {
    // Not a warning: the remedy for a blind model tells the agent not to open
    // images at all, so handing it work that depends on one produces a confident
    // answer that ignored the input.
    const plan = resolveDispatch({
      providers: [blind('prov-blind'), sighted('prov-sighted')],
      preferredProviderId: 'prov-blind',
      input: { kind: 'prompt', prompt: 'read the wireframe', capabilities: ['tool_use', 'vision'] },
      invokeOpts: {},
    });
    expect(plan.providerId).toBe('prov-sighted');
  });

  it('fails with a message that says what to change', () => {
    const plan = resolveDispatch({
      providers: [blind('prov-blind')],
      input: { kind: 'prompt', prompt: 'read the wireframe', capabilities: ['vision'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    // Worded for what is actually unreadable, which is not always an image: a
    // wireframe PDF reaches this branch too, and "remove the images" would send
    // the reader looking for a file they do not have.
    expect(plan.reason).toContain('LOOKING at them');
    expect(plan.reason).toContain('no text could be extracted');
    expect(plan.reason).toContain('vision-capable');
  });

  it('leaves a blind provider alone when no image is involved', () => {
    // Most builds carry no wireframe. Declaring the capability unconditionally
    // would lock every blind model out of all of them.
    const plan = resolveDispatch({
      providers: [blind('prov-blind')],
      input: { kind: 'prompt', prompt: 'plan this', capabilities: ['tool_use'] },
      invokeOpts: {},
    });
    expect(plan.providerId).toBe('prov-blind');
  });

  it('stops applying a stale verdict once the model changes', () => {
    // resolveModelLimits keys the learn to the model it was learned FOR, so
    // switching to a vision model clears it with no invalidation step.
    const swapped = withModel(makeProvider({ id: 'prov-swapped', name: 'codex' }), 'gpt-5.6-sol', {
      model: 'deepseek-v4-flash:cloud',
      vision: false,
      learnedAt: '2026-01-01',
    });
    const plan = resolveDispatch({
      providers: [swapped],
      input: { kind: 'prompt', prompt: 'read the wireframe', capabilities: ['vision'] },
      invokeOpts: {},
    });
    expect(plan.providerId).toBe('prov-swapped');
  });

  it('prefers a sighted provider without refusing a blind one', () => {
    // The soft half, for an input with BOTH forms — a PDF beside its extracted
    // text. Seeing it is better; not seeing it still works.
    const preferred = resolveDispatch({
      providers: [blind('prov-blind'), sighted('prov-sighted')],
      preferredProviderId: 'prov-blind',
      preferVision: true,
      input: { kind: 'prompt', prompt: 'read the pdf', capabilities: ['tool_use'] },
      invokeOpts: {},
    });
    expect(preferred.providerId).toBe('prov-sighted');

    const onlyOption = resolveDispatch({
      providers: [blind('prov-blind')],
      preferVision: true,
      input: { kind: 'prompt', prompt: 'read the pdf', capabilities: ['tool_use'] },
      invokeOpts: {},
    });
    expect(onlyOption.mode).toBe('cli');
    expect(onlyOption.providerId).toBe('prov-blind');
  });

  it('keeps the explicit preference when both providers can see', () => {
    const plan = resolveDispatch({
      providers: [sighted('prov-a'), sighted('prov-b')],
      preferredProviderId: 'prov-b',
      preferVision: true,
      input: { kind: 'prompt', prompt: 'read the pdf', capabilities: ['tool_use'] },
      invokeOpts: {},
    });
    expect(plan.providerId).toBe('prov-b');
  });
});

describe('agent rules injection', () => {
  // makeProvider copies only the fields it names, so rules are set on the record it returns.
  const claude = (rulesContent?: string): CliProviderRecord => ({
    ...makeProvider({ id: 'prov-claude', name: 'claude-code' }),
    ...(rulesContent !== undefined ? { rulesContent } : {}),
  });
  const dispatch = (
    extra: Partial<Parameters<typeof resolveDispatch>[0]>,
    prompt = 'do the work',
    provider = claude(),
  ) => {
    const plan = resolveDispatch({
      providers: [provider],
      input: { kind: 'prompt', prompt, capabilities: [] },
      invokeOpts: {},
      ...extra,
    });
    if (plan.invocation?.kind !== 'cli') throw new Error('expected a cli invocation');
    return { prompt: plan.effectivePrompt!, spec: plan.invocation.spec };
  };
  const hashOf = (rules: string) => agentRulesHash(rules);

  it('opens every prompt with the provider effective rules when switched on', () => {
    const { prompt, spec } = dispatch({ agentRulesInjection: true });
    expect(prompt.startsWith(AGENT_RULES_MARKER)).toBe(true);
    expect(prompt).toContain(DEFAULT_AGENT_RULES.trim().split('\n')[0]!);
    expect(prompt.endsWith('do the work')).toBe(true);
    expect(spec.agentRules).toEqual({ hash: hashOf(DEFAULT_AGENT_RULES), injected: true });
  });

  it('gives each provider its own rules, not a merge', () => {
    const { prompt, spec } = dispatch({ agentRulesInjection: true }, 'x', claude('- only mine'));
    expect(prompt).toContain('- only mine');
    expect(prompt).not.toContain(DEFAULT_AGENT_RULES.trim().split('\n')[0]!);
    expect(spec.agentRules).toEqual({ hash: hashOf('- only mine'), injected: true });
  });

  it('adds nothing when the switch is absent, and records why', () => {
    const { prompt, spec } = dispatch({});
    expect(prompt).toBe(`${NO_MCP}do the work`);
    expect(spec.agentRules).toEqual({
      hash: hashOf(DEFAULT_AGENT_RULES),
      injected: false,
      reason: 'disabled',
    });
  });

  it('adds nothing to a dispatch that opts out, and records why', () => {
    const { prompt, spec } = dispatch({ agentRulesInjection: true, skipAgentRules: true });
    expect(prompt).not.toContain(AGENT_RULES_MARKER);
    expect(spec.agentRules?.reason).toBe('opt-out');
  });

  it('gives a stored prompt dispatched again the current rules, once', () => {
    const first = dispatch({ agentRulesInjection: true }, 'do the work', claude('- old'));
    const again = dispatch({ agentRulesInjection: true }, first.prompt, claude('- new'));
    expect(again.prompt.split(AGENT_RULES_MARKER)).toHaveLength(2);
    expect(again.prompt).toContain('- new');
    expect(again.prompt).not.toContain('- old');
    expect(again.prompt).toBe(
      dispatch({ agentRulesInjection: true }, 'do the work', claude('- new')).prompt,
    );
  });

  it('ends isolation for rules that name an agent path, since the mask would hide the file', () => {
    const isolatedWith = (rules: string) =>
      resolveDispatch({
        providers: [claude(rules)],
        input: { kind: 'prompt', prompt: 'review it', capabilities: ['tool_use'] },
        invokeOpts: {},
        agentIsolation: true,
        agentRulesInjection: true,
      });
    const masked = (plan: ReturnType<typeof resolveDispatch>) =>
      plan.invocation?.kind === 'cli' ? plan.invocation.spec.maskAgentDefinitions === true : null;
    expect(masked(isolatedWith('- Keep changes small.'))).toBe(true);
    expect(masked(isolatedWith('- Read .claude/agents/reviewer.md first.'))).toBe(false);
  });

  it('drops the rules rather than fail a prompt they would push past an argv-only limit', () => {
    const gemini = makeProvider({ id: 'prov-gemini', name: 'gemini', authMode: 'api_key' });
    const overhead = (prompt: string) =>
      Buffer.byteLength(dispatch({}, prompt, gemini).prompt, 'utf8') -
      Buffer.byteLength(prompt, 'utf8');
    const fits = 'x'.repeat(PROMPT_ARGV_LIMIT_BYTES - overhead('x') - 16);
    const { prompt, spec } = dispatch({ agentRulesInjection: true }, fits, gemini);
    expect(prompt).not.toContain(AGENT_RULES_MARKER);
    expect(spec.agentRules).toEqual({
      hash: hashOf(DEFAULT_AGENT_RULES),
      injected: false,
      reason: 'prompt-too-large',
    });
  });

  it('still fails a prompt too large even without the rules', () => {
    const gemini = makeProvider({ id: 'prov-gemini', name: 'gemini', authMode: 'api_key' });
    expect(() =>
      dispatch({ agentRulesInjection: true }, 'x'.repeat(PROMPT_ARGV_LIMIT_BYTES + 10), gemini),
    ).toThrow(PromptTooLargeError);
  });
});
