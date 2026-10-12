import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { recordLeftOpenMerges } from './left-open-merge.js';

describe('recordLeftOpenMerges', () => {
  it('throws when it cannot read, so the cancel is re-driven before it is marked finished', async () => {
    const failing = {
      select: () => {
        throw new Error('connection lost');
      },
    } as unknown as Database;
    await expect(recordLeftOpenMerges(failing, 'task-1')).rejects.toThrow('connection lost');
  });
});
