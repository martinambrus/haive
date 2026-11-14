import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { configService } from '@haive/shared';

const runInSandbox = vi.hoisted(() => vi.fn());
vi.mock('../src/sandbox/sandbox-runner.js', async (original) => ({
  ...(await original<object>()),
  runInSandbox,
}));
import { executeCliSpec } from '../src/queues/cli-exec/exec-core.js';
import { defaultDeps } from '../src/queues/cli-exec/_shared.js';
import { resolveInvocationCost } from '../src/queues/cli-exec/invocation-cost.js';

afterEach(() => vi.restoreAllMocks());

it('keeps full exec tokenUsage and the cost snapshot byte-identical to the pre-change fixture', async () => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  const stdout = readFileSync(new URL('./fixtures/streams/ollama.jsonl', import.meta.url), 'utf8');
  runInSandbox.mockImplementationOnce(async (opts) => {
    opts.onStdoutChunk?.(stdout);
    return {
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs: 1,
      timedOut: false,
      resolvedCommand: 'ollama',
      wrapperId: null,
    };
  });
  const outcome = await executeCliSpec(
    { command: 'ollama', args: [], env: {}, outputFormat: 'claude-stream-json' },
    defaultDeps,
  );
  const rates = {
    inputRate: 0.000003,
    outputRate: 0.000015,
    cacheReadRate: 0.0000003,
    cacheWriteRate: 0.00000375,
    cacheWrite1hRate: 0.000006,
  };
  const db = {
    query: {
      cliProviders: { findFirst: async () => ({ authMode: 'api_key', model: 'qwen3:1.7b' }) },
      cliPricingSync: { findFirst: async () => undefined },
    },
    select: () => ({
      from: () => ({
        where: async () => [
          {
            id: 'manual',
            provider: 'ollama',
            modelKey: 'qwen3:1.7b',
            source: 'manual',
            rates,
            effectiveFrom: new Date('2026-01-01'),
          },
        ],
      }),
    }),
  } as unknown as Database;
  const cost = await resolveInvocationCost(db, {
    cliProviderId: 'provider',
    providerName: 'ollama',
    tokenUsage: outcome.tokenUsage ?? null,
    modelIdentity: outcome.modelIdentity ?? null,
  });
  const bytes = JSON.stringify({ tokenUsage: outcome.tokenUsage, cost });
  const baseline = new URL('./fixtures/streams/ollama-cost-baseline.json', import.meta.url);
  expect(bytes).toBe(JSON.parse(readFileSync(baseline, 'utf8')).bytes);
});
