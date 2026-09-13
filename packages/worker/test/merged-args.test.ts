import { describe, expect, it } from 'vitest';
import { dropArgsAlreadyInBase } from '../src/cli-adapters/base-adapter.js';
import { ClaudeCodeAdapter } from '../src/cli-adapters/claude-code.js';
import { CodexAdapter } from '../src/cli-adapters/codex.js';
import { OllamaAdapter } from '../src/cli-adapters/ollama.js';
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

/** Every occurrence of `flag`, each with the token after it. */
const pairsOf = (args: string[], flag: string): string[][] =>
  args.flatMap((tok, i) => (tok === flag ? [[tok, args[i + 1] ?? '<end>']] : []));

describe('dropArgsAlreadyInBase', () => {
  it('drops a flag the adapter already passes on its own', () => {
    expect(dropArgsAlreadyInBase(['--verbose', '--foo'], ['-p', '--verbose'])).toEqual(['--foo']);
  });

  it('drops a flag and its value only as the exact pair the adapter passes', () => {
    expect(dropArgsAlreadyInBase(['--model', 'llama3'], ['--model', 'llama3'])).toEqual([]);
    expect(dropArgsAlreadyInBase(['--model', 'qwen3'], ['--model', 'llama3'])).toEqual([
      '--model',
      'qwen3',
    ]);
  });

  it('never drops a lone value that happens to appear somewhere in base', () => {
    expect(
      dropArgsAlreadyInBase(
        ['--append-system-prompt', 'stream-json'],
        ['--output-format', 'stream-json'],
      ),
    ).toEqual(['--append-system-prompt', 'stream-json']);
  });

  it('keeps flags base does not use, with their values', () => {
    expect(dropArgsAlreadyInBase(['--add-dir', '/x', '--json'], ['exec'])).toEqual([
      '--add-dir',
      '/x',
      '--json',
    ]);
  });
});

describe('stored provider args through a real adapter', () => {
  it('codex keeps a stored -c override whole beside its own effort override', () => {
    const spec = new CodexAdapter().buildCliInvocation(
      provider({ cliArgs: ['-c', 'model_reasoning_summary=detailed'] }),
      'do x',
      {},
    );
    expect(pairsOf(spec.args, '-c').length).toBeGreaterThanOrEqual(2);
    // Stored args go ahead of the subcommand, so a stranded value would be read as one.
    expect(spec.args.slice(0, 3)).toEqual(['-c', 'model_reasoning_summary=detailed', 'exec']);
  });

  it('ollama keeps a stored --model beside the provider model, and folds an identical one', () => {
    const differing = new OllamaAdapter().buildCliInvocation(
      provider({ model: 'llama3', cliArgs: ['--model', 'qwen3'] }),
      'do x',
      {},
    );
    expect(pairsOf(differing.args, '--model')).toEqual([
      ['--model', 'qwen3'],
      ['--model', 'llama3'],
    ]);
    const same = new OllamaAdapter().buildCliInvocation(
      provider({ model: 'llama3', cliArgs: ['--model', 'llama3'] }),
      'do x',
      {},
    );
    expect(pairsOf(same.args, '--model')).toEqual([['--model', 'llama3']]);
  });

  it('claude folds a duplicated boolean and keeps a value that matches one of its own', () => {
    const spec = new ClaudeCodeAdapter().buildCliInvocation(
      provider({
        cliArgs: ['--dangerously-skip-permissions', '--append-system-prompt', 'stream-json'],
      }),
      'do x',
      { steeringMode: true },
    );
    expect(spec.args.filter((t) => t === '--dangerously-skip-permissions')).toHaveLength(1);
    expect(pairsOf(spec.args, '--append-system-prompt')).toEqual([
      ['--append-system-prompt', 'stream-json'],
    ]);
  });
});
