import { describe, expect, it, vi } from 'vitest';
import {
  defaultCliSpawner,
  runSequentialSubAgent,
  type CliExecutionResult,
  type CliSpawner,
} from '../src/cli-executor/index.js';
import type { CliCommandSpec, SubAgentInvocation } from '../src/cli-adapters/types.js';

const echoCommand: CliCommandSpec = {
  command: '/bin/sh',
  args: ['-c', 'echo hello'],
  env: {},
};

const failCommand: CliCommandSpec = {
  command: '/bin/sh',
  args: ['-c', 'exit 7'],
  env: {},
};

const missingCommand: CliCommandSpec = {
  command: '/bin/definitely-not-here',
  args: [],
  env: {},
};

describe('defaultCliSpawner', () => {
  it('captures stdout and returns exit 0 for a trivial command', async () => {
    const result = await defaultCliSpawner(echoCommand);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
  });

  it('returns the non-zero exit code for a failing command', async () => {
    const result = await defaultCliSpawner(failCommand);
    expect(result.exitCode).toBe(7);
  });

  it('reports an error when the executable is missing', async () => {
    const result = await defaultCliSpawner(missingCommand);
    expect(result.exitCode).toBeNull();
    expect(result.error).toBeDefined();
  });

  it('streams stdout chunks to the callback', async () => {
    const chunks: string[] = [];
    await defaultCliSpawner(echoCommand, {
      onStdoutChunk: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join('')).toContain('hello');
  });
});

function mockSpawner(results: Record<string, Partial<CliExecutionResult>>): CliSpawner {
  return async (spec) => {
    const prompt = spec.args[spec.args.length - 1] ?? '';
    const matches = Object.keys(results).filter((k) => prompt.includes(k));
    matches.sort((a, b) => b.length - a.length);
    const key = matches[0];
    const base: CliExecutionResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    };
    if (!key) return base;
    return { ...base, ...results[key]! };
  };
}

const sequentialInvocation: SubAgentInvocation = {
  mode: 'sequential',
  steps: [
    {
      id: 'scan',
      prompt: 'scan the repo for TODO comments',
      expectJsonOutput: true,
      collectInto: 'scan',
    },
    {
      id: 'label',
      prompt: 'label each finding',
      expectJsonOutput: true,
      collectInto: 'labels',
    },
  ],
  synthesis: {
    id: 'synthesis',
    prompt: 'produce the final report',
    expectJsonOutput: false,
  },
};

describe('runSequentialSubAgent', () => {
  it('collects parsed JSON outputs from each step and runs synthesis', async () => {
    const spawner = mockSpawner({
      scan: { stdout: '<<<JSON>>>{"found": 3}<<<ENDJSON>>>' },
      label: { stdout: '```json\n{"labels":["a","b"]}\n```' },
      'final report': { stdout: 'Done!' },
    });
    const buildCli = (prompt: string): CliCommandSpec => ({
      command: 'dummy',
      args: ['-p', prompt],
      env: {},
    });
    const result = await runSequentialSubAgent(sequentialInvocation, buildCli, spawner);
    expect(result.exitCode).toBe(0);
    expect(result.collected).toEqual({
      scan: { found: 3 },
      labels: { labels: ['a', 'b'] },
    });
    expect(result.synthesis).toBe('Done!');
    expect(result.trace.map((t) => t.id)).toEqual(['scan', 'label', 'synthesis']);
  });

  it('stops at the first failing step and reports the failure', async () => {
    const spawner = mockSpawner({
      scan: { exitCode: 3, stderr: 'something broke' },
      label: { stdout: 'should-not-run' },
    });
    const synthesisSpy = vi.fn();
    const buildCli = (prompt: string): CliCommandSpec => {
      if (prompt.includes('final report')) synthesisSpy();
      return { command: 'dummy', args: ['-p', prompt], env: {} };
    };
    const result = await runSequentialSubAgent(sequentialInvocation, buildCli, spawner);
    expect(result.exitCode).toBe(3);
    expect(result.collected).toEqual({});
    expect(result.synthesis).toBeNull();
    expect(result.trace.map((t) => t.id)).toEqual(['scan']);
    expect(synthesisSpy).not.toHaveBeenCalled();
  });

  it('appends collected context to the synthesis prompt', async () => {
    const spawner = mockSpawner({
      scan: { stdout: '{"ok":1}' },
      label: { stdout: '{"ok":2}' },
      final: { stdout: 'fine' },
    });
    const seenPrompts: string[] = [];
    const buildCli = (prompt: string): CliCommandSpec => {
      seenPrompts.push(prompt);
      return { command: 'dummy', args: ['-p', prompt], env: {} };
    };
    await runSequentialSubAgent(sequentialInvocation, buildCli, spawner);
    const synthesisPrompt = seenPrompts[seenPrompts.length - 1] ?? '';
    expect(synthesisPrompt).toContain('Collected sub-agent outputs:');
    expect(synthesisPrompt).toContain('scan');
    expect(synthesisPrompt).toContain('labels');
  });

  it('wraps unparseable stdout in __rawOutput when JSON was expected', async () => {
    const spawner = mockSpawner({
      scan: { stdout: 'not valid json' },
      label: { stdout: '{"ok": true}' },
      final: { stdout: 'done' },
    });
    const buildCli = (prompt: string): CliCommandSpec => ({
      command: 'dummy',
      args: ['-p', prompt],
      env: {},
    });
    const result = await runSequentialSubAgent(sequentialInvocation, buildCli, spawner);
    expect(result.collected.scan).toEqual({ __rawOutput: 'not valid json' });
    expect(result.collected.labels).toEqual({ ok: true });
  });

  it('unwraps codex JSONL sub-step output and sums token usage', async () => {
    const jsonl = (text: string, input: number, output: number) =>
      [
        JSON.stringify({ type: 'thread.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: input, output_tokens: output },
        }),
      ].join('\n') + '\n';
    const spawner = mockSpawner({
      scan: { stdout: jsonl('<<<JSON>>>{"found":3}<<<ENDJSON>>>', 100, 10) },
      label: { stdout: jsonl('```json\n{"labels":["a"]}\n```', 50, 5) },
      'final report': { stdout: jsonl('Done!', 20, 2) },
    });
    const buildCli = (prompt: string): CliCommandSpec => ({
      command: 'codex',
      args: ['exec', '--json', prompt],
      env: {},
      outputFormat: 'codex-jsonl',
    });
    const result = await runSequentialSubAgent(sequentialInvocation, buildCli, spawner);
    expect(result.exitCode).toBe(0);
    expect(result.collected).toEqual({ scan: { found: 3 }, labels: { labels: ['a'] } });
    expect(result.synthesis).toBe('Done!');
    expect(result.tokenUsage).toEqual({ inputTokens: 170, outputTokens: 17, totalTokens: 187 });
  });

  it('unwraps gemini JSON envelopes and falls back to raw stdout for plain output', async () => {
    const gem = (response: string, prompt: number, candidates: number) =>
      JSON.stringify({
        response,
        stats: {
          models: {
            'gemini-2.5-pro': {
              tokens: {
                prompt,
                candidates,
                total: prompt + candidates,
                cached: 0,
                thoughts: 0,
                tool: 0,
              },
            },
          },
        },
      });
    const spawner = mockSpawner({
      scan: { stdout: gem('<<<JSON>>>{"found":1}<<<ENDJSON>>>', 10, 2) },
      // Older binary ignoring the flag: plain stdout still parses as today.
      label: { stdout: '{"labels":["x"]}' },
      'final report': { stdout: gem('All good', 5, 1) },
    });
    // mockSpawner matches on the LAST arg — keep the prompt last.
    const buildCli = (prompt: string): CliCommandSpec => ({
      command: 'gemini',
      args: ['--output-format', 'json', '-p', prompt],
      env: {},
      outputFormat: 'gemini-json',
    });
    const result = await runSequentialSubAgent(sequentialInvocation, buildCli, spawner);
    expect(result.collected).toEqual({ scan: { found: 1 }, labels: { labels: ['x'] } });
    expect(result.synthesis).toBe('All good');
    expect(result.tokenUsage).toEqual({ inputTokens: 15, outputTokens: 3, totalTokens: 18 });
  });
});
