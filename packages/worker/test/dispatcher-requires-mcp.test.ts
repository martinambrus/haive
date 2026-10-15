import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';
import {
  resolveDispatch,
  resolveTaskDispatch,
  type DispatchInput,
} from '../src/orchestrator/dispatcher.js';
import type { CliProviderRecord, SubAgentSpec } from '../src/cli-adapters/types.js';
import type { McpSurface } from '../src/sandbox/mcp-surface.js';

vi.mock('../src/orchestrator/global-kb-context.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbContext: async () => ({
    digest: { entries: [], omitted: 0, scanSaturated: false },
    rules: [],
    refused: [],
    status: 'ok',
  }),
}));

function provider(id: string, name: string, over: Partial<CliProviderRecord> = {}) {
  const now = new Date();
  return {
    id,
    userId: 'user-1',
    name,
    label: name,
    executablePath: null,
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    supportsSubagents: false,
    authMode: 'subscription',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as CliProviderRecord;
}

const AMP = provider('prov-amp', 'amp');
const CLAUDE = provider('prov-claude', 'claude-code');
const CODEX = provider('prov-codex', 'codex');

const LINE_START = "- `haive-custom`: tools this step's author defined: `repo_status`.";

function surface(custom?: McpSurface['custom']): McpSurface {
  return {
    ragOnly: false,
    rag: { enabled: false, apiUrl: '', token: '' },
    chromeDevtools: { enabled: false, version: null },
    ddevControl: { enabled: false, apiUrl: '', token: '' },
    userServers: {},
    ...(custom ? { custom } : {}),
  };
}

const prompt: DispatchInput = { kind: 'prompt', prompt: 'Audit it.', capabilities: ['tool_use'] };

describe('requiresMcp: a candidate whose CLI cannot host MCP servers is ineligible', () => {
  it('takes the next provider that can when the preferred one is amp', () => {
    const plan = resolveDispatch({
      providers: [AMP, CLAUDE],
      preferredProviderId: AMP.id,
      requiresMcp: true,
      input: prompt,
      invokeOpts: {},
    });
    expect(plan.mode).toBe('cli');
    expect(plan.providerName).toBe('claude-code');
  });

  it('keeps the order among the providers that can', () => {
    const plan = resolveDispatch({
      providers: [AMP, CLAUDE, CODEX],
      preferredProviderId: CODEX.id,
      requiresMcp: true,
      input: prompt,
      invokeOpts: {},
    });
    expect(plan.providerName).toBe('codex');
  });

  it('fails with a reason that names MCP when amp is the only provider', () => {
    const plan = resolveDispatch({
      providers: [AMP],
      requiresMcp: true,
      input: prompt,
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    expect(plan.providerId).toBeNull();
    expect(plan.reason).toMatch(/MCP/);
    expect(plan.reason).not.toBe('no provider matched required capabilities');
  });

  it('does not count a provider that can host them but is disabled', () => {
    const plan = resolveDispatch({
      providers: [AMP, { ...CLAUDE, enabled: false }],
      requiresMcp: true,
      input: prompt,
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toMatch(/MCP/);
  });

  it('still sends a dispatch that does not need MCP to amp', () => {
    for (const requiresMcp of [undefined, false]) {
      const plan = resolveDispatch({
        providers: [AMP, CLAUDE],
        preferredProviderId: AMP.id,
        ...(requiresMcp === undefined ? {} : { requiresMcp }),
        input: prompt,
        invokeOpts: {},
      });
      expect(plan.providerName).toBe('amp');
    }
  });

  it('names MCP, not images, when every provider that could see lacks MCP', () => {
    const plan = resolveDispatch({
      providers: [AMP],
      requiresMcp: true,
      input: { kind: 'prompt', prompt: 'Look.', capabilities: ['vision'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toMatch(/MCP/);
  });

  it('keeps naming images when no provider can see, whatever MCP needs', () => {
    const blind = provider('prov-blind', 'codex', {
      model: 'deepseek-v4-flash:cloud',
      modelLimits: { model: 'deepseek-v4-flash:cloud', vision: false, learnedAt: '2026-01-01' },
    } as Partial<CliProviderRecord>);
    const plan = resolveDispatch({
      providers: [blind],
      requiresMcp: true,
      input: { kind: 'prompt', prompt: 'Look.', capabilities: ['vision'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toMatch(/images/);
  });

  it('does not name MCP when a provider that can host it was passed over for another reason', () => {
    const plan = resolveDispatch({
      providers: [AMP, CODEX],
      requiresMcp: true,
      input: { kind: 'prompt', prompt: 'Audit it.', capabilities: ['subagents'] },
      invokeOpts: {},
    });
    expect(plan.mode).toBe('skip');
    expect(plan.reason).toBe('no provider matched required capabilities');
  });

  it('applies to a sub-agent dispatch as well', () => {
    const spec: SubAgentSpec = {
      subAgents: [{ name: 'detector', prompt: 'Detect', outputKey: 'detect' }],
      synthesisPrompt: 'Summarize',
    };
    const input: DispatchInput = { kind: 'subagent', spec, capabilities: ['subagents'] };
    const only = resolveDispatch({
      providers: [AMP],
      requiresMcp: true,
      input,
      invokeOpts: {},
    });
    expect(only.mode).toBe('skip');
    expect(only.reason).toMatch(/MCP/);
    const either = resolveDispatch({
      providers: [AMP, CLAUDE],
      preferredProviderId: AMP.id,
      requiresMcp: true,
      input,
      invokeOpts: {},
    });
    expect(either.providerName).toBe('claude-code');
  });
});

describe('the custom tools line of a dispatch', () => {
  const custom = { enabled: true, tools: ['repo_status'] };

  it('reaches the prompt of an MCP-capable provider and no other', () => {
    const base = {
      mcpSurface: surface(custom),
      input: prompt,
      invokeOpts: {},
    };
    const claude = resolveDispatch({ providers: [CLAUDE], ...base });
    expect(claude.effectivePrompt).toContain(LINE_START);
    const amp = resolveDispatch({ providers: [AMP], ...base });
    expect(amp.effectivePrompt).not.toContain('haive-custom');
  });

  it('leaves the prompt of a dispatch without custom tools as it was', () => {
    const plain = resolveDispatch({
      providers: [CLAUDE],
      mcpSurface: surface(),
      input: prompt,
      invokeOpts: {},
    });
    expect(plain.effectivePrompt).not.toContain('haive-custom');
  });
});

describe('resolveTaskDispatch carries the custom tool names into the surface', () => {
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({
          userId: 'u1',
          envTemplateId: null,
          repositoryId: null,
          worktreeBranch: null,
        }),
      },
      repositories: { findFirst: async () => undefined },
      taskSteps: { findFirst: async () => undefined },
      envTemplates: { findFirst: async () => undefined },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }),
      }),
    }),
  } as unknown as Database;

  beforeEach(() => {
    process.env.CONFIG_ENCRYPTION_KEY = 'dispatcher-requires-mcp-secret';
    vi.spyOn(configService, 'getBoolean').mockImplementation(async (_key, def = false) => def);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CONFIG_ENCRYPTION_KEY;
  });

  it('names them in the prompt and sends amp-preferred work to a provider that can run them', async () => {
    const plan = await resolveTaskDispatch(db, 'task-1', {
      providers: [AMP, CLAUDE],
      preferredProviderId: AMP.id,
      customTools: ['repo_status'],
      requiresMcp: true,
      input: prompt,
      invokeOpts: {},
    });
    expect(plan.providerName).toBe('claude-code');
    expect(plan.effectivePrompt).toContain(LINE_START);
  });

  it('adds no line, and keeps amp, for a dispatch that names no tools', async () => {
    const plan = await resolveTaskDispatch(db, 'task-1', {
      providers: [AMP, CLAUDE],
      preferredProviderId: AMP.id,
      input: prompt,
      invokeOpts: {},
    });
    expect(plan.providerName).toBe('amp');
    expect(plan.effectivePrompt).not.toContain('haive-custom');
  });
});
