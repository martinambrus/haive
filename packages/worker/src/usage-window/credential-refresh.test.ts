import { describe, it, expect } from 'vitest';
import { taskVolumesHoldProvider } from './credential-refresh.js';

// The yield rule. A per-task auth volume existing for a CLI means a task holds a COPY of
// the same credential and may refresh off the same single-use refresh token; rotating the
// user volume at that moment signs one of the two out mid-run. Getting this wrong in the
// permissive direction breaks a running task, so the false answers are not symmetric.
describe('taskVolumesHoldProvider', () => {
  const TASK_GROK = 'haive_cli_auth_task_dd682d32fe60_grok_0';
  const TASK_CODEX = 'haive_cli_auth_task_c58cd9729db8_codex_0';
  const USER_GROK = 'haive_cli_auth_0a2cb56857b4_grok_0';
  const USER_GROK_APIKEY = 'haive_cli_auth_0a2cb56857b4_grok_k_0';
  const PROVIDER_GROK = 'haive_cli_auth_p_012c35842bb5_grok_0';

  it('holds when a per-task volume for that CLI exists', () => {
    expect(taskVolumesHoldProvider([TASK_CODEX, TASK_GROK], 'grok')).toBe(true);
  });

  it('does not hold when only other CLIs have task volumes', () => {
    expect(taskVolumesHoldProvider([TASK_CODEX], 'grok')).toBe(false);
  });

  it('does not hold on an empty host', () => {
    expect(taskVolumesHoldProvider([], 'grok')).toBe(false);
  });

  // The user and per-provider volumes are the things being rotated, not copies of it.
  // Treating them as a hold would mean never rotating at all.
  it('ignores user and per-provider volumes', () => {
    expect(taskVolumesHoldProvider([USER_GROK, USER_GROK_APIKEY, PROVIDER_GROK], 'grok')).toBe(
      false,
    );
  });

  it('matches a hyphenated CLI name', () => {
    expect(
      taskVolumesHoldProvider(['haive_cli_auth_task_c58cd9729db8_claude-code_1'], 'claude-code'),
    ).toBe(true);
  });
});
