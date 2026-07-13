import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/cli-adapters/claude-code.js';
import { ZaiAdapter } from '../src/cli-adapters/zai.js';
import { OllamaAdapter } from '../src/cli-adapters/ollama.js';
import { CodexAdapter } from '../src/cli-adapters/codex.js';
import { GeminiAdapter } from '../src/cli-adapters/gemini.js';
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
  it('is true for Claude-family adapters (claude binary), false for the rest', () => {
    expect(new ClaudeCodeAdapter().supportsSteering).toBe(true);
    expect(new ZaiAdapter().supportsSteering).toBe(true);
    expect(new OllamaAdapter().supportsSteering).toBe(true);
    expect(new CodexAdapter().supportsSteering).toBe(false);
    expect(new GeminiAdapter().supportsSteering).toBe(false);
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
