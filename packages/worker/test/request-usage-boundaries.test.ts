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
        coverage: outputFormat === 'gemini-json' ? 'complete' : 'unknown',
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
      coverage: 'complete',
      requestCount: 2,
      wholeRun: { requestCount: 2 },
      inputConvention: 'inclusive',
    });
  });
});

it('carries a codex exec whole-run proof through executeCliSpec into pricing', async () => {
  const { resolveInvocationCost } = await import('../src/queues/cli-exec/invocation-cost.js');
  const { createCodexJsonlCollector } = await import('../src/cli-executor/codex-jsonl.js');
  const data = fixture('codex-exec');
  const stdout = jsonl(data);
  sandbox.mockImplementationOnce(async (opts) => {
    opts.onStdoutChunk?.(stdout);
    return spawned(stdout);
  });
  const result = await executeCliSpec(
    { command: 'codex', args: ['--model', 'model'], env: {}, outputFormat: 'codex-jsonl' },
    defaultDeps,
  );
  expect(result.requestUsage).toMatchObject({
    requests: null,
    coverage: 'unknown',
    wholeRun: { requestCount: null, usage: { model: 'model', inputTokens: 100 } },
  });
  const base = {
    inputRate: 1e-7,
    outputRate: 5e-7,
    cacheReadRate: 1e-8,
    cacheWriteRate: null,
    cacheWrite1hRate: null,
  };
  const store = (tiers: boolean) =>
    ({
      query: {
        cliProviders: { findFirst: async () => ({ authMode: 'api_key', model: 'model' }) },
        cliPricingSync: { findFirst: async () => undefined },
      },
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: 'price',
              provider: 'codex',
              modelKey: 'model',
              source: 'litellm',
              rates: {
                ...base,
                ...(tiers
                  ? { tiers: [{ ...base, aboveTokens: 100000, inclusive: false, inputRate: 9e-7 }] }
                  : {}),
              },
              effectiveFrom: new Date(),
            },
          ],
        }),
      }),
    }) as unknown as import('@haive/database').Database;
  const input = {
    cliProviderId: 'provider',
    providerName: 'codex',
    tokenUsage: result.tokenUsage ?? null,
    modelIdentity: result.modelIdentity ?? null,
    requestUsage: result.requestUsage,
  };
  const cost = await resolveInvocationCost(store(true), input);
  const flat = await resolveInvocationCost(store(false), input);
  expect(cost).toMatchObject({
    source: flat!.source,
    billable: flat!.billable,
    costUsd: flat!.costUsd,
    tier: { state: 'exact' },
  });
  for (const broken of [
    stdout + '{broken\n',
    stdout + 'null\n',
    stdout + stdout,
    jsonl(data.slice(0, -1)),
    jsonl(data.slice(1)),
  ]) {
    const collector = createCodexJsonlCollector();
    collector.onChunk(broken);
    expect(collector.getRequestUsage('model')).not.toHaveProperty('wholeRun');
  }
});

it('preserves independent whole-run proofs across zero-assistant-usage sequential sub-steps', async () => {
  const events = [
    { type: 'system', subtype: 'init', model: 'model-a' },
    {
      type: 'assistant',
      message: { id: 'one', model: 'model-a', usage: { input_tokens: 0, output_tokens: 0 } },
    },
    { type: 'result', usage: { input_tokens: 10, output_tokens: 2 } },
  ];
  const result = await runSequentialSubAgent(
    {
      mode: 'sequential',
      steps: [{ id: 'scan', prompt: 'scan', expectJsonOutput: false }],
      synthesis: { id: 'finish', prompt: 'finish', expectJsonOutput: false },
    },
    () => ({ command: 'cli', args: [], env: {}, outputFormat: 'claude-stream-json' }),
    async () => spawned(jsonl(events)),
    {},
    extractClaudeStreamSubStep,
  );
  expect(result.requestUsage).toMatchObject({
    coverage: 'incomplete',
    wholeRun: { requestCount: 2, usage: { model: 'model-a', inputTokens: 20, outputTokens: 4 } },
  });
});
