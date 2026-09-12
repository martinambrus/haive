import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/cli-adapters/claude-code.js';
import { ZaiAdapter } from '../src/cli-adapters/zai.js';
import { OllamaAdapter } from '../src/cli-adapters/ollama.js';
import { MuseAdapter } from '../src/cli-adapters/muse.js';
import { CodexAdapter } from '../src/cli-adapters/codex.js';
import { GeminiAdapter } from '../src/cli-adapters/gemini.js';
import { GrokAdapter } from '../src/cli-adapters/grok.js';
import { AmpAdapter } from '../src/cli-adapters/amp.js';
import { AntigravityAdapter } from '../src/cli-adapters/antigravity.js';
import { OpenRouterAdapter } from '../src/cli-adapters/openrouter.js';
import { steeringUserMessageLine } from '../src/cli-adapters/steering.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

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

describe('supportsSteering capability', () => {
  // EVERY adapter is asserted here, including the false ones. amp and antigravity were absent
  // from this table when amp shipped steering, which is how the capability set went stale for
  // three months without a test noticing.
  it('is true for the claude binary and for amp, false for the rest', () => {
    expect(new ClaudeCodeAdapter().supportsSteering).toBe(true);
    expect(new ZaiAdapter().supportsSteering).toBe(true);
    expect(new OllamaAdapter().supportsSteering).toBe(true);
    expect(new MuseAdapter().supportsSteering).toBe(true);
    expect(new OpenRouterAdapter().supportsSteering).toBe(true);
    // amp reads NDJSON user-messages from stdin under --stream-json-input and honours a
    // top-level `steer: true` as "apply at the next interruption point while the agent is
    // busy". Verified against the shipped binary's own --help.
    expect(new AmpAdapter().supportsSteering).toBe(true);
    // codex exec is fire-and-forget; turn/steer exists only in its app-server JSON-RPC
    // protocol, which is a different transport entirely.
    expect(new CodexAdapter().supportsSteering).toBe(false);
    expect(new GeminiAdapter().supportsSteering).toBe(false);
    // grok is agentic and Claude-shaped on the wire, but its headless streams are
    // read-only — bidirectional flows need its ACP interface (`grok agent`), not stdin.
    expect(new GrokAdapter().supportsSteering).toBe(false);
    // antigravity already speaks --input-format stream-json, but its docs say to wait for the
    // `result` event before writing the next message: that is a queued follow-up TURN, not a
    // mid-turn steer.
    expect(new AntigravityAdapter().supportsSteering).toBe(false);
  });
});

describe('steeringUserMessageLine', () => {
  // The claude binary has no `steer` field. The flag is opt-in precisely so the line every
  // claude-family adapter emits is byte-identical to what shipped before amp needed one.
  it('omits the steer marker by default', () => {
    expect(steeringUserMessageLine('hello')).toBe(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}\n',
    );
    expect(steeringUserMessageLine('hello', {})).toBe(steeringUserMessageLine('hello'));
    expect(steeringUserMessageLine('hello', { steer: false })).toBe(
      steeringUserMessageLine('hello'),
    );
  });

  it('adds amp"s top-level steer marker when asked', () => {
    const parsed = JSON.parse(steeringUserMessageLine('hello', { steer: true }).trim());
    expect(parsed.steer).toBe(true);
    expect(parsed.message.content[0].text).toBe('hello');
  });
});

describe('amp buildCliInvocation', () => {
  it('one-shot (default): prompt on -x, no input stream, not steerable', () => {
    const spec = new AmpAdapter().buildCliInvocation(provider(), 'hello world', {});
    expect(spec.args).toContain('hello world');
    expect(spec.args).not.toContain('--stream-json-input');
    expect(spec.steerable).toBeUndefined();
    expect(spec.stdinInitial).toBeUndefined();
    expect(spec.steerFlag).toBeUndefined();
  });

  it('steering: bare -x plus --stream-json-input, prompt off argv, NDJSON stdinInitial', () => {
    const spec = new AmpAdapter().buildCliInvocation(provider(), 'hello world', {
      steeringMode: true,
    });
    // amp"s --help: --stream-json-input "Requires both --execute and --stream-json".
    expect(spec.args).toContain('-x');
    expect(spec.args).toContain('--stream-json');
    expect(spec.args).toContain('--stream-json-input');
    // `-x` carries no value: the message arrives on stdin.
    expect(spec.args[spec.args.indexOf('-x') + 1]).toBe('--stream-json');
    expect(spec.args).not.toContain('hello world');
    expect(spec.steerable).toBe(true);
    expect(spec.steerFlag).toBe(true);
    expect(spec.stdinPrompt).toBeUndefined(); // mutually exclusive with stdinInitial
    const parsed = JSON.parse(spec.stdinInitial!.trim());
    expect(parsed.message.content[0].text).toBe('hello world');
    // The INITIAL message is never flagged: there is no turn in progress to interrupt.
    expect(parsed.steer).toBeUndefined();
  });
});

describe('grok buildCliInvocation', () => {
  it('declares subscription auth so BOTH login modes stay legal', () => {
    // Mirrors the catalog, where this value is a capability flag rather than a
    // default: 'api_key' there would make `grok login --device-auth` unreachable.
    const adapter = new GrokAdapter();
    expect(adapter.defaultAuthMode).toBe('subscription');
    expect(adapter.apiKeyEnvName).toBe('XAI_API_KEY');
    // The device-code authorization server, not just the inference host.
    expect(adapter.defaultEgressDomains).toContain('accounts.x.ai');
    expect(adapter.defaultEgressDomains).toContain('api.x.ai');
  });

  it('emits an Anthropic-wire stream and parses as claude-stream-json', () => {
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'hello world', {});
    expect(spec.command).toBe('grok');
    expect(spec.outputFormat).toBe('claude-stream-json');
    expect(spec.args).toContain('--output-format');
    expect(spec.args).toContain('streaming-messages-json');
    expect(spec.args).toContain('--always-approve');
    // Prompt rides -p, and every flag stays ahead of it.
    expect(spec.args.slice(-2)).toEqual(['-p', 'hello world']);
    expect(spec.steerable).toBeUndefined();
  });

  it('falls back to the catalog default model rather than letting grok pick its own', () => {
    // grok's built-in default is a different family (grok-4.20-*-non-reasoning), so omitting
    // -m would silently contradict the model the catalog and the provider form advertise.
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'p', {});
    expect(spec.args).toContain('-m');
    expect(spec.args[spec.args.indexOf('-m') + 1]).toBe('grok-build-0.1');
  });

  it('passes the provider model when set', () => {
    const spec = new GrokAdapter().buildCliInvocation(provider({ model: 'grok-4.6' }), 'p', {});
    expect(spec.args[spec.args.indexOf('-m') + 1]).toBe('grok-4.6');
  });

  it('maps disallowedTools onto the comma-separated deny-list (mining blocks Agent)', () => {
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'p', {
      disallowedTools: ['Agent'],
    });
    expect(spec.args[spec.args.indexOf('--disallowed-tools') + 1]).toBe('Agent');
  });

  it('maps disableTools onto an emptied allow-list', () => {
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'p', { disableTools: true });
    expect(spec.args[spec.args.indexOf('--tools') + 1]).toBe('');
  });

  it('omits both tool flags when neither option is set', () => {
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'p', {});
    expect(spec.args).not.toContain('--disallowed-tools');
    expect(spec.args).not.toContain('--tools');
  });

  it("never requests grok's own sandbox (the task container is the boundary)", () => {
    const spec = new GrokAdapter().buildCliInvocation(provider(), 'p', {});
    expect(spec.args).not.toContain('--sandbox');
  });
});

describe('claude-code buildCliInvocation', () => {
  it('one-shot (default): prompt is a -p positional, not steerable', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(provider(), 'hello world', {});
    expect(spec.args).toContain('hello world');
    expect(spec.args).not.toContain('--input-format');
    expect(spec.steerable).toBeUndefined();
    expect(spec.stdinInitial).toBeUndefined();
  });

  it('steering: --input-format stream-json, prompt off argv, NDJSON stdinInitial', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(provider(), 'hello world', {
      steeringMode: true,
    });
    const i = spec.args.indexOf('--input-format');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toBe('stream-json');
    // prompt must NOT be a positional arg in steering mode
    expect(spec.args).not.toContain('hello world');
    expect(spec.steerable).toBe(true);
    expect(spec.stdinInitial!.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(spec.stdinInitial!.trim());
    expect(parsed.type).toBe('user');
    expect(parsed.message.role).toBe('user');
    expect(parsed.message.content[0].text).toBe('hello world');
    // amp's marker must never reach the claude binary, which has no such field.
    expect(parsed.steer).toBeUndefined();
    expect(spec.steerFlag).toBeUndefined();
  });

  it('steering NDJSON is injection-safe for quotes/newlines (JSON.stringify, not concat)', () => {
    const nasty = 'stop; do "X"\nand {y}';
    const spec = new ClaudeCodeAdapter().buildCliInvocation(provider(), nasty, {
      steeringMode: true,
    });
    // exactly one NDJSON line (the embedded newline must be escaped, not literal)
    expect(spec.stdinInitial!.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(spec.stdinInitial!.trim()).message.content[0].text).toBe(nasty);
  });
});

describe('disallowedTools threads through every claude-family adapter', () => {
  const denyAt = (args: string[]): string[] => {
    const i = args.indexOf('--disallowedTools');
    return i < 0 ? [] : args.slice(i + 1, i + 2);
  };

  it('claude-code one-shot: --disallowedTools Agent present', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(provider(), 'do x', {
      disallowedTools: ['Agent'],
    });
    expect(denyAt(spec.args)).toEqual(['Agent']);
  });

  it('claude-code steering: --disallowedTools Agent present', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(provider(), 'do x', {
      steeringMode: true,
      disallowedTools: ['Agent'],
    });
    expect(denyAt(spec.args)).toEqual(['Agent']);
  });

  it('zai: --disallowedTools Agent present', () => {
    const spec = new ZaiAdapter().buildCliInvocation(provider(), 'do x', {
      disallowedTools: ['Agent'],
    });
    expect(denyAt(spec.args)).toEqual(['Agent']);
  });

  it('ollama: --disallowedTools Agent present and ordered before --model', () => {
    const spec = new OllamaAdapter().buildCliInvocation(provider({ model: 'llama3' }), 'do x', {
      disallowedTools: ['Agent'],
    });
    expect(denyAt(spec.args)).toEqual(['Agent']);
    expect(spec.args.indexOf('--disallowedTools')).toBeLessThan(spec.args.indexOf('--model'));
  });

  it('omitted → no --disallowedTools flag (unchanged default)', () => {
    for (const spec of [
      new ClaudeCodeAdapter().buildCliInvocation(provider(), 'do x', {}),
      new ZaiAdapter().buildCliInvocation(provider(), 'do x', {}),
      new OllamaAdapter().buildCliInvocation(provider({ model: 'llama3' }), 'do x', {}),
    ]) {
      expect(spec.args).not.toContain('--disallowedTools');
    }
  });
});

describe('disableTools threads --tools "" through every claude-family adapter', () => {
  // claude's documented "disable all built-in tools" is `--tools ""` (empty value).
  const toolsValueAt = (args: string[]): string[] => {
    const i = args.indexOf('--tools');
    return i < 0 ? [] : [args[i + 1]!];
  };

  it('claude-code one-shot: --tools "" present (empty-string value)', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(provider(), 'do x', {
      disableTools: true,
    });
    expect(spec.args).toContain('--tools');
    expect(toolsValueAt(spec.args)).toEqual(['']);
  });

  it('claude-code steering: --tools "" present', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(provider(), 'do x', {
      steeringMode: true,
      disableTools: true,
    });
    expect(toolsValueAt(spec.args)).toEqual(['']);
  });

  it('zai: --tools "" present', () => {
    const spec = new ZaiAdapter().buildCliInvocation(provider(), 'do x', {
      disableTools: true,
    });
    expect(toolsValueAt(spec.args)).toEqual(['']);
  });

  it('ollama: --tools "" present, empty value ordered right before --model', () => {
    const spec = new OllamaAdapter().buildCliInvocation(provider({ model: 'llama3' }), 'do x', {
      disableTools: true,
    });
    const i = spec.args.indexOf('--tools');
    expect(i).toBeGreaterThanOrEqual(0);
    // the empty value must survive between --tools and --model, not be dropped —
    // otherwise --tools would greedily swallow --model.
    expect(spec.args[i + 1]).toBe('');
    expect(spec.args[i + 2]).toBe('--model');
  });

  it('omitted → no --tools flag (unchanged default: all tools available)', () => {
    for (const spec of [
      new ClaudeCodeAdapter().buildCliInvocation(provider(), 'do x', {}),
      new ZaiAdapter().buildCliInvocation(provider(), 'do x', {}),
      new OllamaAdapter().buildCliInvocation(provider({ model: 'llama3' }), 'do x', {}),
    ]) {
      expect(spec.args).not.toContain('--tools');
    }
  });

  it('empty-string value survives mergedArgs even with provider cliArgs present', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(
      provider({ cliArgs: ['--model', 'sonnet'] }),
      'do x',
      { disableTools: true },
    );
    const i = spec.args.indexOf('--tools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(spec.args[i + 1]).toBe('');
  });
});

describe('ollama steering variant keeps --model', () => {
  it('steering args include --input-format and --model <model>', () => {
    const spec = new OllamaAdapter().buildCliInvocation(provider({ model: 'llama3' }), 'do x', {
      steeringMode: true,
    });
    expect(spec.args).toContain('--input-format');
    expect(spec.args).toContain('--model');
    expect(spec.args[spec.args.indexOf('--model') + 1]).toBe('llama3');
    expect(spec.args).not.toContain('do x');
    expect(spec.steerable).toBe(true);
  });
});
