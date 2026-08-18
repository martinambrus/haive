import { describe, expect, it } from 'vitest';
import { cliAdapterRegistry } from '../src/cli-adapters/registry.js';
import type { CliProviderName, CliProviderRecord } from '../src/cli-adapters/types.js';

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
    effortLevel: overrides.effortLevel ?? null,
    // Only ollama reads this in buildCliInvocation (and throws without it); every
    // other adapter treats a null the same as the absent field it saw before.
    model: overrides.model ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  } as CliProviderRecord;
}

describe('effortScale declarations', () => {
  it('claude-code exposes the five-level scale with max=max', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(adapter.effortScale!.max).toBe('max');
  });

  it('zai mirrors the claude-code scale because it wraps the same binary', () => {
    const adapter = cliAdapterRegistry.get('zai');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'max']);
    expect(adapter.effortScale!.max).toBe('max');
  });

  // The mirror image of zai: Muse HAS xhigh but has no max. api.meta.ai rejects
  // `max` with a 400, which is exactly why muse is its own adapter rather than a
  // claude-code provider with a different base URL.
  it('muse exposes low..xhigh with max=xhigh and no max level', () => {
    const adapter = cliAdapterRegistry.get('muse');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(adapter.effortScale!.max).toBe('xhigh');
    expect(adapter.effortScale!.values).not.toContain('max');
  });

  it('codex exposes the six-level scale with max=ultra (no minimal)', () => {
    const adapter = cliAdapterRegistry.get('codex');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(adapter.effortScale!.max).toBe('ultra');
  });

  // grok is here despite `grok --effort <level>` existing, because the flag is inert on the
  // models Haive reaches AND an unknown level is accepted silently instead of rejected — so
  // there is no menu to expose and no probe that could discover one. See the measurement on the
  // catalog entry before reinstating a scale.
  it.each<CliProviderName>(['gemini', 'amp', 'grok'])(
    '%s reports no effort knob (effortScale=null)',
    (name) => {
      const adapter = cliAdapterRegistry.get(name);
      expect(adapter.effortScale).toBeNull();
    },
  );
});

describe('effortEnv emission', () => {
  it('claude-code translates each declared level into CLAUDE_CODE_EFFORT_LEVEL', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    for (const level of adapter.effortScale!.values) {
      expect(adapter.effortEnv(level)).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: level });
    }
  });

  it('muse translates each declared level into CLAUDE_CODE_EFFORT_LEVEL', () => {
    const adapter = cliAdapterRegistry.get('muse');
    for (const level of adapter.effortScale!.values) {
      expect(adapter.effortEnv(level)).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: level });
    }
  });

  it('grok emits no env for any level (it has no effort knob at all)', () => {
    const adapter = cliAdapterRegistry.get('grok');
    for (const level of ['low', 'high', 'max', 'bogus-level']) {
      expect(adapter.effortEnv(level)).toEqual({});
    }
  });

  it('codex emits no env (its effort knob is a CLI arg, not an env var)', () => {
    const adapter = cliAdapterRegistry.get('codex');
    expect(adapter.effortEnv('high')).toEqual({});
    expect(adapter.effortEnv('xhigh')).toEqual({});
  });

  it('gemini (no scale) returns an empty env regardless of level', () => {
    const adapter = cliAdapterRegistry.get('gemini');
    expect(adapter.effortEnv('high')).toEqual({});
    expect(adapter.effortEnv('whatever')).toEqual({});
  });
});

describe('mergedEnv resolution through buildCliInvocation', () => {
  it('falls back to scale.max when provider.effortLevel is null', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({ id: 'p1', name: 'claude-code' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  // Regression guard for the onboard_muse failure: on the claude-code adapter an
  // unset effort_level fell back to scale.max = 'max', which api.meta.ai rejects
  // with `400 unsupported output_config.effort value max`. On muse the same
  // fallback must land on xhigh.
  it('muse falls back to xhigh, never max, when provider.effortLevel is null', () => {
    const adapter = cliAdapterRegistry.get('muse');
    const provider = makeProvider({ id: 'p-muse', name: 'muse' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('xhigh');
  });

  // A row carrying a stale 'max' (e.g. migrated from the claude-code adapter)
  // must not reach the CLI at all: resolveEffortLevel drops out-of-scale values
  // rather than passing them through.
  it('muse drops an out-of-scale max instead of forwarding it', () => {
    const adapter = cliAdapterRegistry.get('muse');
    const provider = makeProvider({ id: 'p-muse', name: 'muse', effortLevel: 'max' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('uses provider.effortLevel when set to a valid value', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({ id: 'p1', name: 'claude-code', effortLevel: 'medium' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium');
  });

  it('opts.effortLevel overrides provider.effortLevel', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({ id: 'p1', name: 'claude-code', effortLevel: 'low' });
    const spec = adapter.buildCliInvocation(provider, 'hi', {
      cwd: '/w',
      effortLevel: 'high',
    });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });

  it('drops invalid levels rather than poisoning the CLI env', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({
      id: 'p1',
      name: 'claude-code',
      effortLevel: 'super-extreme',
    });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('emits no effort env for adapters with effortScale=null', () => {
    const adapter = cliAdapterRegistry.get('gemini');
    const provider = makeProvider({ id: 'p1', name: 'gemini', effortLevel: 'high' });
    const spec = adapter.buildCliInvocation(provider, 'hi', {
      cwd: '/w',
      effortLevel: 'max',
    });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('preserves provider.envVars and opts.extraEnv around the effort injection', () => {
    const adapter = cliAdapterRegistry.get('claude-code');
    const provider = makeProvider({
      id: 'p1',
      name: 'claude-code',
      envVars: { FOO: 'bar' },
      effortLevel: 'medium',
    });
    const spec = adapter.buildCliInvocation(provider, 'hi', {
      cwd: '/w',
      extraEnv: { BAZ: 'qux' },
    });
    expect(spec.env.FOO).toBe('bar');
    expect(spec.env.BAZ).toBe('qux');
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('medium');
  });
});

describe('codex arg-based effort injection', () => {
  function findReasoningArg(args: string[]): string | null {
    const idx = args.indexOf('-c');
    if (idx === -1) return null;
    const next = args[idx + 1];
    return next && next.startsWith('model_reasoning_effort=') ? next : null;
  }

  it('injects -c model_reasoning_effort="ultra" by default (scale.max)', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p1', name: 'codex' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(findReasoningArg(spec.args)).toBe('model_reasoning_effort="ultra"');
  });

  it('uses provider.effortLevel when set', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p1', name: 'codex', effortLevel: 'low' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(findReasoningArg(spec.args)).toBe('model_reasoning_effort="low"');
  });

  it('opts.effortLevel overrides provider.effortLevel', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p1', name: 'codex', effortLevel: 'low' });
    const spec = adapter.buildCliInvocation(provider, 'hi', {
      cwd: '/w',
      effortLevel: 'high',
    });
    expect(findReasoningArg(spec.args)).toBe('model_reasoning_effort="high"');
  });

  it('drops invalid levels rather than injecting a poisoned -c arg', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({
      id: 'p1',
      name: 'codex',
      effortLevel: 'not-a-real-level',
    });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(findReasoningArg(spec.args)).toBeNull();
  });

  it('never emits effort as an env var', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p1', name: 'codex', effortLevel: 'high' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(spec.env.CODEX_REASONING_EFFORT).toBeUndefined();
  });

  it('places -c after exec but before --skip-git-repo-check and the prompt', () => {
    const adapter = cliAdapterRegistry.get('codex');
    const provider = makeProvider({ id: 'p1', name: 'codex', effortLevel: 'medium' });
    const spec = adapter.buildCliInvocation(provider, 'the-prompt', { cwd: '/w' });
    const execIdx = spec.args.indexOf('exec');
    const cIdx = spec.args.indexOf('-c');
    const skipIdx = spec.args.indexOf('--skip-git-repo-check');
    const promptIdx = spec.args.indexOf('the-prompt');
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThan(execIdx);
    expect(skipIdx).toBeGreaterThan(cIdx);
    expect(promptIdx).toBeGreaterThan(skipIdx);
  });
});

// OpenRouter's accepted effort levels are a GATEWAY contract, measured by posting an
// out-of-range `output_config.effort` and reading the 400 back:
//   "Invalid option: expected one of \"low\"|\"medium\"|\"high\"|\"xhigh\"|\"max\""
// The same enum is returned for a model whose supported_parameters has no `reasoning`,
// so it is not per-model — those models answer 200 and normalize the level away. Two
// consequences this locks down: the scale is the five-level claude-code one (NOT the
// four-level CLAUDE_LIKE scale the other wrapper adapters use), and since no level can
// 400 on a model basis the ordinary unset -> scale.max default is safe.
describe('openrouter effort scale', () => {
  it('declares the measured five-level gateway enum, including xhigh', () => {
    const adapter = cliAdapterRegistry.get('openrouter');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(adapter.effortScale!.max).toBe('max');
  });

  it('sends xhigh — the level the four-level CLAUDE_LIKE scale would have dropped', () => {
    const adapter = cliAdapterRegistry.get('openrouter');
    const provider = makeProvider({ id: 'p1', name: 'openrouter', effortLevel: 'xhigh' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('xhigh');
  });

  it('defaults an unset level to scale.max like its claude-family siblings', () => {
    const adapter = cliAdapterRegistry.get('openrouter');
    const provider = makeProvider({ id: 'p1', name: 'openrouter', effortLevel: null });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('lets an explicit per-step level win over the stored one', () => {
    const adapter = cliAdapterRegistry.get('openrouter');
    const provider = makeProvider({ id: 'p1', name: 'openrouter', effortLevel: 'high' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w', effortLevel: 'low' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
  });

  it('drops a level the gateway would reject rather than forwarding it', () => {
    const adapter = cliAdapterRegistry.get('openrouter');
    const provider = makeProvider({ id: 'p1', name: 'openrouter', effortLevel: 'ultra' });
    const spec = adapter.buildCliInvocation(provider, 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });
});

// Ollama's levels are Anthropic-wire `output_config.effort`, which its compat layer
// maps to the native think level. Accepted set is api.ThinkValue.IsValid, measured
// against the running daemon. The scale is the ONE in the codebase whose default is
// not its top level — see OLLAMA_EFFORT_SCALE in the adapter for the measurements
// (gpt-oss reasons LESS at `max` than at `high`; deepseek-v4-pro at `max` emptied its
// whole budget into the thinking channel). `high` is also what the claude binary sent
// on its own before this scale existed, so the default is behaviour-preserving.
describe('ollama effort scale', () => {
  function ollamaProvider(overrides: Partial<CliProviderRecord> = {}): CliProviderRecord {
    return makeProvider({ id: 'p-ollama', name: 'ollama', model: 'qwen3.5:2b', ...overrides });
  }

  it('declares the four levels ollama accepts', () => {
    const adapter = cliAdapterRegistry.get('ollama');
    expect(adapter.effortScale).not.toBeNull();
    expect(adapter.effortScale!.values).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('defaults to high rather than its top level', () => {
    const adapter = cliAdapterRegistry.get('ollama');
    expect(adapter.effortScale!.max).toBe('high');
    const spec = adapter.buildCliInvocation(ollamaProvider(), 'hi', { cwd: '/w' });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });

  it('forwards max when the user explicitly opts into it', () => {
    const adapter = cliAdapterRegistry.get('ollama');
    const spec = adapter.buildCliInvocation(ollamaProvider({ effortLevel: 'max' }), 'hi', {
      cwd: '/w',
    });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max');
  });

  it('lets an explicit per-step level win over the stored one', () => {
    const adapter = cliAdapterRegistry.get('ollama');
    const spec = adapter.buildCliInvocation(ollamaProvider({ effortLevel: 'high' }), 'hi', {
      cwd: '/w',
      effortLevel: 'low',
    });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
  });

  // xhigh is not in the scale even though ollama's compat layer folds it into
  // `high`: exposing a level that silently becomes another one is a worse UI than
  // not offering it, and resolveEffortLevel drops it rather than forwarding.
  it.each(['xhigh', 'ultra', 'super-extreme'])('drops the out-of-scale level %s', (level) => {
    const adapter = cliAdapterRegistry.get('ollama');
    const spec = adapter.buildCliInvocation(ollamaProvider({ effortLevel: level }), 'hi', {
      cwd: '/w',
    });
    expect(spec.env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
  });

  it('translates each declared level into CLAUDE_CODE_EFFORT_LEVEL', () => {
    const adapter = cliAdapterRegistry.get('ollama');
    for (const level of adapter.effortScale!.values) {
      expect(adapter.effortEnv(level)).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: level });
    }
  });

  // The interactive/terminal path resolves effort too, so a shell opened against an
  // ollama provider reasons at the same level its steps do.
  it('applies the level to buildShellEnv as well', () => {
    const adapter = cliAdapterRegistry.get('ollama');
    const env = adapter.buildShellEnv(ollamaProvider({ effortLevel: 'low' }), {});
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
  });
});
