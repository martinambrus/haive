import { readdirSync, readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  GUARD_DECISION_BOUNDS,
  evaluateGuardDecision,
  parseGuardDecision,
} from '../src/step-engine/guard-decisions.js';
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
  const packages = new URL('../../', import.meta.url);
  function check(dir: URL): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) check(file);
      else if (
        file.pathname !== new URL('../src/step-engine/guard-decisions.ts', import.meta.url).pathname
      )
        expect(readFileSync(file, 'utf8'), file.pathname).not.toMatch(
          /evaluateGuardDecision|guard-decisions/,
        );
    }
  }
  for (const entry of readdirSync(packages, { withFileTypes: true }))
    if (entry.isDirectory()) check(new URL(`${entry.name}/src/`, packages));
});

it('pins the production SQL, lock and predicate bounds', () => {
  expect(GUARD_DECISION_BOUNDS).toEqual({
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 1_000,
    predicateTimeoutMs: 5_000,
  });
});
