import { describe, it, expect } from 'vitest';
import { classifyDagIssueFailure, dagEnvironmentHaltReason } from './dag-failure-class.js';

describe('classifyDagIssueFailure', () => {
  it('transient: SIGKILL (137), SIGINT (130), SIGTERM (143), null exit', () => {
    for (const exitCode of [137, 130, 143, null]) {
      expect(classifyDagIssueFailure({ exitCode, errorMessage: null })).toBe('transient');
    }
  });

  it('transient: worker-restart orphan marker even when a 0 exit code was recorded', () => {
    expect(
      classifyDagIssueFailure({
        exitCode: 0,
        errorMessage: 'CLI invocation orphaned by a worker restart (worker exited mid-run)',
      }),
    ).toBe('transient');
  });

  it('transient: stopped-before-finished / premature-stream markers', () => {
    expect(
      classifyDagIssueFailure({
        exitCode: 0,
        errorMessage: 'CLI process was stopped before it finished (cancelled or timed out).',
      }),
    ).toBe('transient');
    expect(
      classifyDagIssueFailure({
        errorMessage: 'LLM emitted no result event (stream ended prematurely — likely timeout)',
      }),
    ).toBe('transient');
  });

  it('environment: EACCES / root-owned worktree', () => {
    expect(
      classifyDagIssueFailure({
        exitCode: 1,
        concerns: 'every write returned EACCES on a root:root worktree',
      }),
    ).toBe('environment');
  });

  it('environment: no cli provider', () => {
    expect(
      classifyDagIssueFailure({
        exitCode: 1,
        errorMessage: 'no cli provider available: all skipped',
      }),
    ).toBe('environment');
  });

  it('environment: transient re-dispatch exhausted marker', () => {
    expect(classifyDagIssueFailure({ concerns: 'DAG_INFRA_EXHAUSTED: killed 3 times' })).toBe(
      'environment',
    );
  });

  it('genuine: clean exit 0 but no valid ISSUE_RESULT_JSON', () => {
    expect(
      classifyDagIssueFailure({
        exitCode: 0,
        concerns: 'coder exited 0 without a valid ISSUE_RESULT_JSON; refusing to infer success',
      }),
    ).toBe('genuine');
  });

  it('genuine: plain non-termination error exit', () => {
    expect(
      classifyDagIssueFailure({ exitCode: 1, errorMessage: 'coder crashed: TypeError at x.ts:9' }),
    ).toBe('genuine');
  });

  it('environment wins over a kill signal when both are present (do not loop on a perms bug)', () => {
    expect(
      classifyDagIssueFailure({ exitCode: 137, concerns: 'EACCES writing worktree file' }),
    ).toBe('environment');
  });
});

describe('dagEnvironmentHaltReason (only environment failures halt)', () => {
  it('returns the detail for an environment failure', () => {
    expect(dagEnvironmentHaltReason({ concerns: 'root:root worktree, EACCES' })).toContain(
      'EACCES',
    );
  });
  it('is null for a killed coder (re-dispatched) and a clean no-JSON (escalated)', () => {
    expect(
      dagEnvironmentHaltReason({ errorMessage: 'CLI process was stopped before it finished' }),
    ).toBeNull();
    expect(
      dagEnvironmentHaltReason({ concerns: 'coder exited 0 without a valid ISSUE_RESULT_JSON' }),
    ).toBeNull();
  });
});
