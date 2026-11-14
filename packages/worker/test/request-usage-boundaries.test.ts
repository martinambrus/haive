import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@haive/shared';
import type { CliCommandSpec, SubAgentInvocation } from '../src/cli-adapters/types.js';
const sandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (original) => ({
  ...(await original<object>()),
  runInSandbox: sandbox,
}));
import { executeCliSpec } from '../src/queues/cli-exec/exec-core.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
import { runSequentialSubAgent } from '../src/cli-executor/sub-agent-runner.js';
import { extractClaudeStreamSubStep } from '../src/queues/cli-exec/sub-agent.js';
import { extractGeminiJsonOutput } from '../src/cli-executor/usage-extract.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/streams/request-${name}.json`, import.meta.url), 'utf8'),
  );
const jsonl = (events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
const spawned = (stdout: string, exitCode = 0) => ({
  stdout,
  exitCode,
  stderr: '',
  durationMs: 1,
  timedOut: false,
  resolvedCommand: 'cli',
  wrapperId: null,
});
afterEach(() => vi.restoreAllMocks());

describe('aggregate-only channels', () => {
  it.each(['codex-jsonl', 'antigravity-stream-json', 'gemini-json'] as const)(
    'returns no request list for %s',
    async (outputFormat) => {
      const name =
        outputFormat === 'codex-jsonl'
          ? 'codex-exec'
          : outputFormat === 'gemini-json'
            ? 'gemini'
            : 'antigravity';
      const data = fixture(name);
      const stdout = Array.isArray(data) ? jsonl(data) : JSON.stringify(data);
      sandbox.mockImplementationOnce(async (opts) => {
        opts.onStdoutChunk?.(stdout);
        return spawned(stdout);
      });
      const result = await executeCliSpec(
        { command: 'cli', args: [], env: {}, outputFormat },
        defaultDeps,
      );
      expect(result.requestUsage).toMatchObject({
        requests: null,
        coverage: 'unknown',
        requestCount: outputFormat === 'gemini-json' ? 1 : null,
      });
    },
  );
  it('sums Gemini request counts across models without inventing a per-request list', () => {
    const data = fixture('gemini');
    data.stats.models['model-b'] = structuredClone(data.stats.models['model-a']);
    expect(extractGeminiJsonOutput(JSON.stringify(data))?.requestUsage).toMatchObject({
      requests: null,
      requestCount: 2,
      modelCoverage: 'mixed',
    });
    delete data.stats.models['model-b'].api.totalRequests;
    expect(extractGeminiJsonOutput(JSON.stringify(data))?.requestUsage.requestCount).toBeNull();
  });
  it.each([null, -1, 0.5, '1'])('refuses an invalid Gemini count %s', (count) => {
    const data = fixture('gemini');
    data.stats.models['model-a'].api.totalRequests = count;
    expect(extractGeminiJsonOutput(JSON.stringify(data))?.requestUsage.requestCount).toBeNull();
  });
  it.each([0, 7])('keeps unknown coverage on the plain exit-%s branch', async (exitCode) => {
    sandbox.mockResolvedValueOnce(spawned('plain text', exitCode));
    const result = await executeCliSpec({ command: 'cli', args: [], env: {} }, defaultDeps);
    expect(result.requestUsage).toMatchObject({ coverage: 'unknown', requests: null });
  });
});

describe('exec result boundaries', () => {
  it.each([0, 7])('carries Claude requests on exit %s', async (exitCode) => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const stdout = jsonl(fixture('claude'));
    sandbox.mockImplementationOnce(async (opts) => {
      opts.onStdoutChunk?.(stdout);
      return spawned(stdout, exitCode);
    });
    const result = await executeCliSpec(
      { command: 'cli', args: [], env: {}, outputFormat: 'claude-stream-json' },
      defaultDeps,
    );
    expect(result.requestUsage).toMatchObject({ coverage: 'complete', requestCount: 2 });
  });
  it('carries partial Claude requests without a result', async () => {
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
    const data = fixture('claude');
    data.pop();
    const stdout = jsonl(data);
    sandbox.mockImplementationOnce(async (opts) => {
      opts.onStdoutChunk?.(stdout);
      return spawned(stdout, 137);
    });
    const result = await executeCliSpec(
      { command: 'cli', args: [], env: {}, outputFormat: 'claude-stream-json' },
      defaultDeps,
    );
    expect(result.requestUsage).toMatchObject({ coverage: 'incomplete' });
    expect(result.requestUsage?.requests).toHaveLength(2);
  });
  it.each(['codex-jsonl', 'gemini-json'] as const)(
    'returns unknown coverage on the failed %s branch',
    async (outputFormat) => {
      const stdout =
        outputFormat === 'gemini-json'
          ? '{"response":null}'
          : jsonl([{ type: 'thread.started', thread_id: 't' }]);
      sandbox.mockImplementationOnce(async (opts) => {
        opts.onStdoutChunk?.(stdout);
        return spawned(stdout, 7);
      });
      const result = await executeCliSpec(
        { command: 'cli', args: [], env: {}, outputFormat },
        defaultDeps,
      );
      expect(result.requestUsage).toMatchObject({ requests: null, coverage: 'unknown' });
    },
  );
  it.each(['completed', 'failed'])('carries app-server requests on a %s turn', async (status) => {
    const events = fixture('codex-app-server');
    events.at(-1).params.turn.status = status;
    const stdout = jsonl(events);
    sandbox.mockImplementationOnce(async (opts) => {
      opts.onStdinWritable?.({ writable: true, write: () => true, end: () => {} });
      opts.onStdoutChunk?.(stdout);
      return spawned(stdout);
    });
    const result = await executeCliSpec(
      {
        command: 'codex',
        args: [],
        env: {},
        outputFormat: 'codex-app-server',
        codexAppServer: { model: 'model-a', effort: null, prompt: 'p', execArgs: [] },
      },
      defaultDeps,
    );
    expect(result.requestUsage).toMatchObject({
      coverage: 'complete',
      requestCount: 2,
      inputConvention: 'inclusive',
    });
  });
});

describe('sequential request aggregation', () => {
  const invocation: SubAgentInvocation = {
    mode: 'sequential',
    steps: [{ id: 'scan', prompt: 'scan', expectJsonOutput: false }],
    synthesis: { id: 'synthesis', prompt: 'synthesis', expectJsonOutput: false },
  };
  const build = (): CliCommandSpec => ({
    command: 'cli',
    args: [],
    env: {},
    outputFormat: 'claude-stream-json',
  });
  it.each([false, true])(
    'preserves requests on the normal/early-failure path: %s',
    async (fail) => {
      const result = await runSequentialSubAgent(
        invocation,
        build,
        async () => spawned(jsonl(fixture('claude')), fail ? 7 : 0),
        {},
        extractClaudeStreamSubStep,
      );
      expect(result.requestUsage.coverage).toBe('complete');
      expect(result.requestUsage.requests).toHaveLength(fail ? 2 : 4);
      expect(new Set(result.requestUsage.requests?.map((r) => r.requestId)).size).toBe(
        fail ? 2 : 4,
      );
      expect(JSON.stringify(result.trace)).not.toContain('requestUsage');
      expect(JSON.stringify(result.trace)).not.toContain('cacheCreation5mTokens');
    },
  );
  it('retains mixed models across sub-steps and refuses complete aggregate coverage', async () => {
    let n = 0;
    const result = await runSequentialSubAgent(
      invocation,
      build,
      async () => {
        const data = fixture('claude');
        if (n++)
          for (const e of data) {
            if (e.message) e.message.model = 'model-b';
            if (e.model) e.model = 'model-b';
          }
        return spawned(jsonl(data));
      },
      {},
      extractClaudeStreamSubStep,
    );
    expect(result.requestUsage).toMatchObject({ coverage: 'incomplete', modelCoverage: 'mixed' });
  });
  it('keeps aggregate-only Gemini counts across sub-steps', async () => {
    const result = await runSequentialSubAgent(
      invocation,
      () => ({ ...build(), outputFormat: 'gemini-json' }),
      async () => spawned(JSON.stringify(fixture('gemini'))),
    );
    expect(result.requestUsage).toMatchObject({
      requests: null,
      coverage: 'unknown',
      requestCount: 2,
      inputConvention: 'inclusive',
    });
  });
});
