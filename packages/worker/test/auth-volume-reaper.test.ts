import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import {
  reapOrphanedTaskAuthVolumes,
  selectOrphanTaskAuthVolumes,
} from '../src/sandbox/auth-volume-reaper.js';

describe('selectOrphanTaskAuthVolumes', () => {
  it('reaps dead-task volumes, spares live-task / per-user / per-provider / foreign', () => {
    const names = [
      'haive_cli_auth_u1userslug00_claude-code_0', // per-user → spare
      'haive_cli_auth_p_provslug0000_gemini_0', // per-provider → spare
      'haive_cli_auth_task_deadtask0001_ollama_0', // dead → reap
      'haive_cli_auth_task_deadtask0001_ollama_1', // dead → reap
      'haive_cli_auth_task_livetask0001_claude-code_0', // live → keep
      'some_unrelated_volume', // not ours → spare
    ];
    const orphans = selectOrphanTaskAuthVolumes(names, new Set(['livetask0001']));
    expect(orphans.sort()).toEqual(
      [
        'haive_cli_auth_task_deadtask0001_ollama_0',
        'haive_cli_auth_task_deadtask0001_ollama_1',
      ].sort(),
    );
  });

  it('is empty when every task volume is live', () => {
    const orphans = selectOrphanTaskAuthVolumes(
      ['haive_cli_auth_task_livetask0001_codex_0'],
      new Set(['livetask0001']),
    );
    expect(orphans).toEqual([]);
  });
});

describe('reapOrphanedTaskAuthVolumes', () => {
  it('removes only volumes whose task is not live and returns the count', async () => {
    // One live task; its slug is the first 12 hex of the (dash-stripped) uuid.
    const liveTaskId = 'live0000-0000-0000-0000-000000000000';
    const liveSlug = liveTaskId.replace(/-/g, '').slice(0, 12); // 'live00000000'
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ id: liveTaskId }] }) }),
    } as unknown as Database;

    const removed: string[] = [];
    const present = [
      `haive_cli_auth_task_${liveSlug}_claude-code_0`, // live → keep
      'haive_cli_auth_task_dead00000000_ollama_0', // dead → reap
      'haive_cli_auth_u1userslug00_claude-code_0', // per-user → spare
    ];
    const count = await reapOrphanedTaskAuthVolumes(db, {
      listTaskAuthVolumes: async () => present,
      removeVolume: async (name) => {
        removed.push(name);
      },
    });

    expect(count).toBe(1);
    expect(removed).toEqual(['haive_cli_auth_task_dead00000000_ollama_0']);
  });

  it('is a no-op when nothing is listed', async () => {
    const db = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
    } as unknown as Database;
    const count = await reapOrphanedTaskAuthVolumes(db, {
      listTaskAuthVolumes: async () => [],
      removeVolume: async () => {
        throw new Error('should not be called');
      },
    });
    expect(count).toBe(0);
  });
});
