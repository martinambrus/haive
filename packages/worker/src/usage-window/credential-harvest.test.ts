import { describe, it, expect } from 'vitest';
import { selectHarvestTargets, type HarvestCandidate } from './credential-harvest.js';

// The two rules that keep a mid-task harvest from being worse than no harvest at all:
// never read an auth file a running CLI may be rewriting, and never attribute one task
// volume to a user volume it might not belong to. Both false answers break a login, so
// the permissive direction is the dangerous one.
const USER = 'u0000000-0000-0000-0000-00000000000a';

function provider(overrides: Partial<HarvestCandidate['provider']> = {}) {
  return {
    id: 'p0000000-0000-0000-0000-00000000000a',
    userId: USER,
    name: 'codex' as const,
    authMode: 'subscription' as const,
    isolateAuth: false,
    ...overrides,
  };
}

const TASK_A = 'ta000000-0000-0000-0000-00000000000a';
const TASK_B = 'tb000000-0000-0000-0000-00000000000b';

describe('selectHarvestTargets', () => {
  it('harvests a task with no running invocation', () => {
    const { targets, ambiguous } = selectHarvestTargets(
      [{ taskId: TASK_A, provider: provider() }],
      new Set(),
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]?.taskId).toBe(TASK_A);
    expect(ambiguous).toHaveLength(0);
  });

  // The CLI rewrites auth.json in place on refresh; copying it mid-write puts a truncated
  // credential where the user's login was. One tick of delay is the whole cost of waiting.
  it('skips a task whose CLI is currently running', () => {
    const { targets } = selectHarvestTargets(
      [{ taskId: TASK_A, provider: provider() }],
      new Set([TASK_A]),
    );
    expect(targets).toHaveLength(0);
  });

  it('harvests the quiet task and skips the busy one', () => {
    const { targets } = selectHarvestTargets(
      [
        { taskId: TASK_A, provider: provider() },
        { taskId: TASK_B, provider: provider() },
      ],
      new Set([TASK_A]),
    );
    expect(targets.map((t) => t.taskId)).toEqual([TASK_B]);
  });

  // Membership is about the credential, not about metering: a CLI absent from
  // CLI_CREDENTIAL_FILES keeps no file this can carry back.
  it('ignores a CLI that has no tracked credential file', () => {
    const { targets, ambiguous } = selectHarvestTargets(
      [{ taskId: TASK_A, provider: provider({ name: 'claude-code' }) }],
      new Set(),
    );
    expect(targets).toHaveLength(0);
    expect(ambiguous).toHaveLength(0);
  });

  // Several rows of one CLI normally share one user volume (the common case: many codex
  // rows, one login). Any row speaks for it, so this must yield ONE target, not one per row.
  it('collapses rows sharing a user volume to a single, stable target', () => {
    const pairs = [
      { taskId: TASK_A, provider: provider({ id: 'p-zzz' }) },
      { taskId: TASK_A, provider: provider({ id: 'p-aaa' }) },
    ];
    const { targets, ambiguous } = selectHarvestTargets(pairs, new Set());
    expect(targets).toHaveLength(1);
    expect(ambiguous).toHaveLength(0);
    // Lowest provider id wins, so a settled tick picks the same row every time.
    expect(targets[0]?.provider.id).toBe('p-aaa');
    expect(selectHarvestTargets([...pairs].reverse(), new Set()).targets[0]?.provider.id).toBe(
      'p-aaa',
    );
  });

  // An isolate_auth row mounts its OWN user volume, so the single task volume could hold
  // either login. Nothing in the volume name says which — refuse rather than guess.
  it('refuses a task mixing an isolated row with a shared one', () => {
    const { targets, ambiguous } = selectHarvestTargets(
      [
        { taskId: TASK_A, provider: provider({ id: 'p-shared' }) },
        { taskId: TASK_A, provider: provider({ id: 'p-isolated', isolateAuth: true }) },
      ],
      new Set(),
    );
    expect(targets).toHaveLength(0);
    expect(ambiguous).toEqual([{ taskId: TASK_A, providerName: 'codex' }]);
  });

  // Same argument for auth mode: an api_key row and a subscription row are two credentials
  // billing two accounts, and resolveCliAuthUserVolumeName gives them separate volumes.
  it('refuses a task mixing auth modes on one CLI', () => {
    const { targets, ambiguous } = selectHarvestTargets(
      [
        { taskId: TASK_A, provider: provider({ id: 'p-sub' }) },
        { taskId: TASK_A, provider: provider({ id: 'p-key', authMode: 'api_key' }) },
      ],
      new Set(),
    );
    expect(targets).toHaveLength(0);
    expect(ambiguous).toEqual([{ taskId: TASK_A, providerName: 'codex' }]);
  });

  // Ambiguity is scoped to one (task, CLI) pair — it must not suppress an unrelated CLI
  // in the same task, or one bad pairing would stall every other credential.
  it('keeps an unrelated CLI in the same task', () => {
    const { targets, ambiguous } = selectHarvestTargets(
      [
        { taskId: TASK_A, provider: provider({ id: 'p-sub' }) },
        { taskId: TASK_A, provider: provider({ id: 'p-key', authMode: 'api_key' }) },
        { taskId: TASK_A, provider: provider({ id: 'p-grok', name: 'grok' }) },
      ],
      new Set(),
    );
    expect(ambiguous).toEqual([{ taskId: TASK_A, providerName: 'codex' }]);
    expect(targets.map((t) => t.provider.name)).toEqual(['grok']);
  });

  it('returns nothing on an empty input', () => {
    expect(selectHarvestTargets([], new Set())).toEqual({ targets: [], ambiguous: [] });
  });
});
