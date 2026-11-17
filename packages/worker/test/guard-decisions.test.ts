import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { evaluateGuardDecision, parseGuardDecision } from '../src/step-engine/guard-decisions.js';
import { assertExecutionContractSupported } from '@haive/shared/modularity';

it('ordinary and inert tasks return without a transaction, predicate or state write', async () => {
  const transaction = vi.fn();
  for (const executionContract of [null, { version: 1, guardedSpans: [] }]) {
    const db = {
      query: { tasks: { findFirst: async () => ({ executionContract }) } },
      transaction,
    };
    expect(
      await evaluateGuardDecision({ db, taskId: 't' } as never, 'unused', new Map()),
    ).toBeNull();
  }
  expect(transaction).not.toHaveBeenCalled();
});

it('refuses malformed durable decisions instead of treating them as false', () => {
  for (const value of [null, {}, { version: 99 }, { version: 1, run: false }])
    expect(() => parseGuardDecision(value)).toThrow('guard-decision-invalid');
});

it('keeps the execution fence closed and the decision service has no skip or handoff writer', () => {
  const executionContract = {
    version: 1,
    guardedSpans: [
      { id: 'x', firstStepId: 'x', lastStepId: 'x', predicateId: 'module.fx.planned', args: {} },
    ],
  };
  expect(() => assertExecutionContractSupported(executionContract)).toThrow('not yet supported');
  const source = readFileSync(
    new URL('../src/step-engine/guard-decisions.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/status\s*:\s*['"]skipped['"]|\.insert\(|\.delete\(|\.add\(/);
  for (const file of [
    '../src/queues/task-queue.ts',
    '../src/queues/run-list.ts',
    '../src/step-engine/step-runner.ts',
  ])
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toContain(
      'evaluateGuardDecision',
    );
});
