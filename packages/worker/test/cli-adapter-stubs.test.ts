import { describe, expect, it } from 'vitest';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type {
  CliProviderRecord,
  InvokeOpts,
  LspLanguage,
  SubAgentSpec,
} from '../src/cli-adapters/types.js';

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

const opts: InvokeOpts = { cwd: '/work/repo' };

describe('zai adapter', () => {
  const adapter = cliAdapterRegistry.get('zai');
  const provider = makeProvider({ id: 'p-zai', name: 'zai' });

  it('declares the claude CLI executable and api-key auth via CLI binary', () => {
    expect(adapter.providerName).toBe('zai');
    expect(adapter.defaultExecutable).toBe('claude');
    expect(adapter.supportsSubagents).toBe(true);
    expect(adapter.supportsCliAuth).toBe(true);
    expect(adapter.defaultAuthMode).toBe('api_key');
    expect(adapter.apiKeyEnvName).toBe('ANTHROPIC_AUTH_TOKEN');
  });

  it('appends --output-format stream-json --verbose to CLI invocations', () => {
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.command).toBe('claude');
    expect(spec.args).toEqual([
      '--dangerously-skip-permissions',
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
  });

  it('rewrites Z_AI_* env vars into ANTHROPIC_*/CLAUDE_MODEL aliases', () => {
    const zProvider = makeProvider({
      id: 'p-zai-env',
      name: 'zai',
      envVars: {
        Z_AI_API_URL: 'https://api.zai.com/v1',
        Z_AI_API_KEY: 'secret-token',
        Z_AI_MODEL: 'glm-4.6',
      },
    });
    const spec = adapter.buildCliInvocation(zProvider, 'hello', opts);
    expect(spec.env.Z_AI_API_URL).toBe('https://api.zai.com/v1');
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://api.zai.com/v1');
    expect(spec.env.Z_AI_API_KEY).toBe('secret-token');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('secret-token');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('secret-token');
    expect(spec.env.Z_AI_MODEL).toBe('glm-4.6');
    expect(spec.env.CLAUDE_MODEL).toBe('glm-4.6');
  });

  it('defaults ANTHROPIC_BASE_URL to the canonical zai endpoint when unset', () => {
    const zProvider = makeProvider({
      id: 'p-zai-bare',
      name: 'zai',
      envVars: { Z_AI_API_KEY: 'only-token' },
    });
    const spec = adapter.buildCliInvocation(zProvider, 'hello', opts);
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('only-token');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('only-token');
  });

  it('promotes a bare ANTHROPIC_API_KEY into ANTHROPIC_AUTH_TOKEN for the claude binary', () => {
    const zProvider = makeProvider({
      id: 'p-zai-direct',
      name: 'zai',
      envVars: { ANTHROPIC_API_KEY: 'direct-key' },
    });
    const spec = adapter.buildCliInvocation(zProvider, 'hello', opts);
    expect(spec.env.ANTHROPIC_API_KEY).toBe('direct-key');
    expect(spec.env.ANTHROPIC_AUTH_TOKEN).toBe('direct-key');
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
  });

  it('builds a native sub-agent invocation that mirrors claude-code', () => {
    const spec: SubAgentSpec = {
      subAgents: [
        { name: 'scanner', prompt: 'Find files', outputKey: 'files' },
        { name: 'labeler', prompt: 'Label them', outputKey: 'labels' },
      ],
      synthesisPrompt: 'Summarize findings',
    };
    const inv = adapter.buildSubAgentInvocation!(provider, spec, opts);
    expect(inv.mode).toBe('native');
    expect(inv.steps.map((s) => s.id)).toEqual(['scanner', 'labeler']);
    expect(inv.steps.map((s) => s.collectInto)).toEqual(['files', 'labels']);
    expect(inv.steps[0]?.prompt).toBe('Find files');
    expect(inv.steps.every((s) => s.expectJsonOutput)).toBe(true);
    expect(inv.synthesis.id).toBe('synthesis');
    expect(inv.synthesis.prompt).toBe('Summarize findings');
    expect(inv.synthesis.expectJsonOutput).toBe(true);
  });
});

describe('antigravity adapter', () => {
  const adapter = cliAdapterRegistry.get('antigravity');
  const provider = makeProvider({ id: 'p-agy', name: 'antigravity' });

  it('declares the agy binary, subscription auth (no api key), and native AGENTS.md rules', () => {
    expect(adapter.providerName).toBe('antigravity');
    expect(adapter.defaultExecutable).toBe('agy');
    expect(adapter.supportsSubagents).toBe(true);
    expect(adapter.supportsCliAuth).toBe(true);
    expect(adapter.defaultAuthMode).toBe('subscription');
    expect(adapter.apiKeyEnvName).toBeNull();
    expect(adapter.rulesFile).toBe('AGENTS.md');
    expect(adapter.rulesFileMode).toBe('native');
  });

  it('builds a non-interactive agy invocation with --log-file (before -p) and captureFile', () => {
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.command).toBe('agy');
    expect(spec.args).toEqual([
      '--dangerously-skip-permissions',
      '--log-file',
      '/haive/agy-log/agy.log',
      '-p',
      'hello',
    ]);
    // captureFile drives the runner's writable log mount + readback — agy reports
    // provider-fatal errors (quota/auth/5xx) ONLY to its log while exiting 0.
    expect(spec.captureFile).toEqual({ containerDir: '/haive/agy-log', fileName: 'agy.log' });
  });
});

describe('adapter outputFormat declarations', () => {
  const cases: [name: string, expected: string | undefined][] = [
    ['claude-code', 'claude-stream-json'],
    ['zai', 'claude-stream-json'],
    ['amp', 'claude-stream-json'],
    ['codex', 'codex-jsonl'],
    ['gemini', 'gemini-json'],
    ['antigravity', undefined],
  ];
  for (const [name, expected] of cases) {
    it(`${name} declares outputFormat ${expected ?? '(none)'}`, () => {
      const adapter = cliAdapterRegistry.get(name as never);
      const provider = makeProvider({ id: `p-${name}`, name: name as never });
      const spec = adapter.buildCliInvocation(provider, 'hello', opts);
      expect(spec.outputFormat).toBe(expected);
    });
  }

  it('codex places --json immediately after the exec subcommand', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p-codex', name: 'codex' });
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    const execIdx = spec.args.indexOf('exec');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(spec.args[execIdx + 1]).toBe('--json');
    expect(spec.args[spec.args.length - 1]).toBe('hello');
  });

  it('codex disables its multi-agent feature (no autonomous subagent fan-out)', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p-codex', name: 'codex' });
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    const i = spec.args.indexOf('--disable');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toBe('multi_agent_v2');
  });

  it('gemini requests JSON output mode', () => {
    const adapter = cliAdapterRegistry.get('gemini');
    const provider = makeProvider({ id: 'p-gemini', name: 'gemini' });
    const spec = adapter.buildCliInvocation(provider, 'hello', opts);
    expect(spec.args).toEqual(['-p', 'hello', '--output-format', 'json']);
  });
});

// The Piebald-AI/claude-code-lsps marketplace has no intelephense plugin (only
// phpactor, whose binary Haive never installs). PHP LSP is intelephense via the
// local drupal-php-lsp plugin, so PHP must NOT resolve to the marketplace
// phpactor plugin in any claude-family adapter. These lock that in.
describe('claude-family LSP plugin install (php uses local intelephense, not marketplace phpactor)', () => {
  for (const name of ['claude-code', 'zai', 'ollama'] as const) {
    const adapter = cliAdapterRegistry.get(name);
    const provider = makeProvider({ id: `p-${name}`, name });
    const drupalLspPath = `/work/repo/.claude/plugins/drupal-php-lsp`;
    const flatArgs = (langs: LspLanguage[], withDrupal = true): string =>
      adapter.buildPluginInstallCommands!(
        provider,
        withDrupal
          ? { repoRoot: '/work/repo', lspLanguages: langs, drupalLspPath }
          : { repoRoot: '/work/repo', lspLanguages: langs },
      )
        .flatMap((c) => c.args)
        .join(' ');

    for (const lang of ['php', 'php-extended'] as const) {
      it(`${name}: ${lang} installs drupal-php-lsp and never phpactor`, () => {
        const flat = flatArgs([lang]);
        expect(flat).not.toContain('phpactor');
        expect(flat).toContain('drupal-php-lsp@drupal-lsp-marketplace');
      });
    }

    it(`${name}: typescript still installs the marketplace vtsls plugin`, () => {
      const flat = flatArgs(['typescript'], false);
      expect(flat).toContain('vtsls@claude-code-lsps');
      expect(flat).not.toContain('phpactor');
    });
  }
});
