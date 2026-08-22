import { describe, it, expect } from 'vitest';
import {
  didNotCompleteIssue,
  miningInvocationId,
  miningOutcome,
  shouldRerollMiningAgent,
  shouldRetryMiningTerminalFailure,
} from './mining-failure.js';
import { overrideOr } from './dispatch-timeout.js';
import type { AgentMiningResult } from './step-definition.js';

const done = (agentId: string, rawOutput: string | null): AgentMiningResult => ({
  agentId,
  agentTitle: agentId,
  status: 'done',
  output: null,
  rawOutput,
  errorMessage: null,
});
const failed = (agentId: string, errorMessage: string | null): AgentMiningResult => ({
  agentId,
  agentTitle: agentId,
  status: 'failed',
  output: null,
  rawOutput: null,
  errorMessage,
});

describe('miningOutcome', () => {
  it('tells a dead agent apart from one that was never dispatched', () => {
    const results = [done('a', '{}'), failed('b', 'boom')];
    expect(miningOutcome(results, 'a')).toEqual({ kind: 'done', raw: '{}' });
    expect(miningOutcome(results, 'b')).toEqual({ kind: 'failed', errorMessage: 'boom' });
    expect(miningOutcome(results, 'c')).toEqual({ kind: 'absent' });
  });

  it('reports a done agent that emitted nothing as done, not absent', () => {
    // It WAS asked and it answered with silence — a different fact from never asking,
    // and the caller degrades on it rather than skipping it.
    expect(miningOutcome([done('a', null)], 'a')).toEqual({ kind: 'done', raw: null });
  });
});

describe('didNotCompleteIssue', () => {
  it('carries the runtime cause so the reader knows which fix applies', () => {
    expect(didNotCompleteIssue('Peer review', 'CLI process exceeded its time budget (30m).')).toBe(
      'Peer review did not complete: CLI process exceeded its time budget (30m). Re-run this step.',
    );
  });

  it('still says something useful with no cause recorded', () => {
    expect(didNotCompleteIssue('Peer review', null)).toContain('did not complete');
    expect(didNotCompleteIssue('Peer review', '   ')).toContain('did not complete');
  });
});

describe('shouldRetryMiningTerminalFailure', () => {
  it('retries a budget timeout — the case the prose-only regex missed', () => {
    // "exceeded its time budget" contains neither "timeout" nor "timed out", so the old
    // word-boundary regex never matched it and the reviewer that most needed a re-roll
    // was the only one that never got one.
    expect(
      shouldRetryMiningTerminalFailure(failed('a', 'CLI process exceeded its time budget (30m).')),
    ).toBe(true);
  });

  it('retries the other infrastructure kills', () => {
    for (const msg of [
      'CLI invocation orphaned by a worker restart (worker exited mid-run)',
      'CLI run preempted for a higher-priority task.',
      'stream ended prematurely',
      'socket hang up',
      'fetch failed',
    ]) {
      expect(shouldRetryMiningTerminalFailure(failed('a', msg))).toBe(true);
    }
  });

  it('does NOT retry a deliberate stop, a cancel, or an unavailable provider', () => {
    // "cli process was stopped" reads as transient to the generic classifier, which is why
    // the veto list is checked first: the user asked for it to stop.
    for (const msg of [
      'CLI process was stopped before it finished (cancelled or timed out).',
      'task cancelled',
      'no cli provider available: every provider is disabled',
    ]) {
      expect(shouldRetryMiningTerminalFailure(failed('a', msg))).toBe(false);
    }
  });

  it('does not retry a successful agent or an unclassifiable failure', () => {
    expect(shouldRetryMiningTerminalFailure(done('a', 'fine'))).toBe(false);
    expect(shouldRetryMiningTerminalFailure(failed('a', null))).toBe(false);
    expect(shouldRetryMiningTerminalFailure(failed('a', 'the model disagreed with itself'))).toBe(
      false,
    );
  });
});

describe('shouldRerollMiningAgent', () => {
  it('re-rolls an agent that RAN — its prose usually parses on a fresh roll', () => {
    expect(shouldRerollMiningAgent([done('a', 'prose, no json')], 'a')).toBe(true);
  });

  it('re-rolls an agent killed by infrastructure', () => {
    expect(
      shouldRerollMiningAgent([failed('a', 'CLI process exceeded its time budget (30m).')], 'a'),
    ).toBe(true);
  });

  it('refuses an agent that died on a fatal provider failure', () => {
    // The bug this exists for: retryOnInvocationFailure vetoed the re-run at the barrier,
    // then apply() asked for the same agent through MiningRetryError and got it — a second
    // wave of doomed calls into an exhausted quota.
    for (const msg of [
      'Provider rate limit or quota exhausted — the provider usage limit is exhausted. (429)',
      'CLI authentication failed — re-authenticate your CLI.',
      'Provider server error (service unavailable) — 503.',
    ]) {
      expect(shouldRerollMiningAgent([failed('a', msg)], 'a')).toBe(false);
    }
  });

  it('refuses a deliberate stop and an unclassifiable failure', () => {
    expect(
      shouldRerollMiningAgent(
        [failed('a', 'CLI process was stopped before it finished (cancelled or timed out).')],
        'a',
      ),
    ).toBe(false);
    expect(shouldRerollMiningAgent([failed('a', null)], 'a')).toBe(false);
  });

  it('refuses an agent that was never dispatched', () => {
    expect(shouldRerollMiningAgent([done('a', '{}')], 'b')).toBe(false);
  });
});

describe('overrideOr', () => {
  const step = (cliTimeoutOverrideMs: number | null) =>
    ({ cliTimeoutOverrideMs }) as Parameters<typeof overrideOr>[0];

  it("uses the user's override in place of the caller's budget", () => {
    expect(overrideOr(step(90 * 60_000), 30 * 60_000)).toBe(90 * 60_000);
  });

  it('falls back to the declared budget when no override is set', () => {
    expect(overrideOr(step(null), 30 * 60_000)).toBe(30 * 60_000);
    expect(overrideOr(step(0), 30 * 60_000)).toBe(30 * 60_000);
  });

  it('leaves an undeclared budget undeclared rather than inventing one', () => {
    expect(overrideOr(step(null), undefined)).toBeUndefined();
    expect(overrideOr(step(90 * 60_000), undefined)).toBe(90 * 60_000);
  });
});

describe('miningInvocationId', () => {
  const withInvocation = (agentId: string, invocationId: string | null): AgentMiningResult => ({
    agentId,
    agentTitle: agentId,
    invocationId,
    status: 'done',
    output: null,
    rawOutput: '{}',
    errorMessage: null,
  });

  it('returns the invocation the named agent ran as', () => {
    const results = [withInvocation('peer-reviewer', 'inv-1'), withInvocation('sec', 'inv-2')];
    expect(miningInvocationId(results, 'sec')).toBe('inv-2');
  });

  it('is null for an agent absent from the batch', () => {
    expect(miningInvocationId([withInvocation('peer-reviewer', 'inv-1')], 'nope')).toBeNull();
  });

  it('is null when the agent never reached dispatch', () => {
    // Recorder treats null as "cannot name one" rather than guessing.
    expect(miningInvocationId([withInvocation('peer-reviewer', null)], 'peer-reviewer')).toBeNull();
  });
});
