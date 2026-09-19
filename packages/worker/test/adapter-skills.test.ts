import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/cli-adapters/claude-code.js';
import { ZaiAdapter } from '../src/cli-adapters/zai.js';
import { OllamaAdapter } from '../src/cli-adapters/ollama.js';
import { MuseAdapter } from '../src/cli-adapters/muse.js';
import { OpenRouterAdapter } from '../src/cli-adapters/openrouter.js';
import { CodexAdapter, codexExecFallbackSpec } from '../src/cli-adapters/codex.js';
import { GeminiAdapter } from '../src/cli-adapters/gemini.js';
import { GrokAdapter } from '../src/cli-adapters/grok.js';
import { AmpAdapter } from '../src/cli-adapters/amp.js';
import { AntigravityAdapter } from '../src/cli-adapters/antigravity.js';
import type { BaseCliAdapter } from '../src/cli-adapters/base-adapter.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import { SANDBOX_USER_HOME } from '../src/sandbox/sandbox-identity.js';

// Each CLI's model should see the repository's skills, described, and none of the vendor's own
// skills competing with them. What each CLI needed was MEASURED on the wire (AGENTS.md, "Skills
// per CLI"), so every adapter is listed here, including the ones that need nothing: a CLI whose
// row is missing is how a capability set goes stale without a test noticing.

const provider = (over: Partial<CliProviderRecord> = {}): CliProviderRecord =>
  ({
    wrapperPath: null,
    executablePath: null,
    cliArgs: [],
    envVars: {},
    effortLevel: null,
    model: null,
    disableThinking: false,
    ...over,
  }) as unknown as CliProviderRecord;

// ollama refuses to build without a model; the others do not need one.
const claudeFamily: Array<[string, BaseCliAdapter, Partial<CliProviderRecord>]> = [
  ['claude-code', new ClaudeCodeAdapter(), {}],
  ['zai', new ZaiAdapter(), {}],
  ['ollama', new OllamaAdapter(), { model: 'llama3' }],
  ['muse', new MuseAdapter(), {}],
  ['openrouter', new OpenRouterAdapter(), {}],
];
const others: Array<[string, BaseCliAdapter]> = [
  ['codex', new CodexAdapter()],
  ['gemini', new GeminiAdapter()],
  ['grok', new GrokAdapter()],
  ['amp', new AmpAdapter()],
  ['antigravity', new AntigravityAdapter()],
];

describe('claude family: bundled skills off', () => {
  // The binary charges its own bundled skills first against an 8,000-char listing budget, so
  // most repo skills reached the model as a bare name (1 of 18 described, MEASURED on 2.1.270).
  for (const [name, adapter, over] of claudeFamily) {
    it(`${name} disables the bundled skills`, () => {
      const spec = adapter.buildCliInvocation(provider(over), 'do x', {});
      expect(spec.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('1');
    });

    it(`${name} lets a provider env var turn them back on`, () => {
      const spec = adapter.buildCliInvocation(
        provider({ ...over, envVars: { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '0' } }),
        'do x',
        {},
      );
      expect(spec.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('0');
    });
  }

  for (const [name, adapter] of others) {
    it(`${name} does not carry the claude switch`, () => {
      const spec = adapter.buildCliInvocation(provider(), 'do x', {});
      expect(spec.env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBeUndefined();
    });
  }
});

describe('codex: system skills off', () => {
  // codex installs and lists five `.system` skills of its own, and `skill-creator` was pulled into
  // 33 runs of Haive's own skill-generation steps (MEASURED on 0.154.0). Every transport has to
  // carry the override, the exec fallback of an app-server run included.
  const codexProvider = provider({ model: 'gpt-5.6-sol' });
  const hasOverride = (args: string[]): boolean => {
    const i = args.indexOf('skills.bundled.enabled=false');
    return i > 0 && args[i - 1] === '-c';
  };

  it('on the one-shot exec run', () => {
    const spec = new CodexAdapter().buildCliInvocation(codexProvider, 'do x', {});
    expect(hasOverride(spec.args)).toBe(true);
  });

  it('on the app-server run and on its exec fallback', () => {
    const spec = new CodexAdapter().buildCliInvocation(codexProvider, 'do x', {
      steeringMode: true,
    });
    expect(hasOverride(spec.args)).toBe(true);
    expect(hasOverride(codexExecFallbackSpec(spec)!.args)).toBe(true);
  });
});

describe('grok: project skills in, bundled skills out', () => {
  // A headless grok run is an untrusted folder, and grok skips project skills and AGENTS.md
  // there: every grok run on the dev install listed 0 repo skills (MEASURED on 1.0.34).
  it('turns folder trust off and keeps the claude-compat hooks off', () => {
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'do x', {});
    expect(spec.env.GROK_FOLDER_TRUST).toBe('0');
    expect(spec.env.GROK_CLAUDE_HOOKS_ENABLED).toBe('0');
  });

  it('lets a provider env var override either', () => {
    const spec = new GrokAdapter().buildCliInvocation(
      provider({ envVars: { GROK_CLAUDE_HOOKS_ENABLED: '1' } }),
      'do x',
      {},
    );
    expect(spec.env.GROK_CLAUDE_HOOKS_ENABLED).toBe('1');
    expect(spec.env.GROK_FOLDER_TRUST).toBe('0');
  });

  it('hides its bundled skills through the managed config layer', () => {
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'do x', {});
    expect(spec.configFiles).toEqual([
      {
        containerPath: '/etc/grok/managed_config.toml',
        content: `[skills]\nignore = ["${SANDBOX_USER_HOME}/.grok/bundled/skills"]\n`,
      },
    ]);
  });

  for (const [name, adapter, over] of [
    ...claudeFamily,
    ...others.filter(([n]) => n !== 'grok').map(([n, a]) => [n, a, {}] as const),
  ]) {
    it(`${name} ships no config file and no grok switches`, () => {
      const spec = adapter.buildCliInvocation(provider(over), 'do x', {});
      expect(spec.configFiles).toBeUndefined();
      expect(spec.env.GROK_FOLDER_TRUST).toBeUndefined();
    });
  }
});
