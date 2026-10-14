import { describe, expect, it } from 'vitest';
import { schema, type DbTx } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { reviveRefusal } from '../src/onboarding-admission.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

describe('reviving a task', () => {
  it.each([
    ['plan_merge', [`plan-merge:${REPO}`, `onboarding-upgrade:${REPO}`]],
    ['plan_chat', [`onboarding-upgrade:${REPO}`]],
  ])(
    'a %s takes the plan-merge lock only when it holds the scratch worktree',
    async (type, want) => {
      const fake = createFakeDb({ tasks: schema.tasks });
      fake.insert(schema.tasks, {
        id: TASK,
        userId: USER,
        repositoryId: REPO,
        type,
        status: 'failed',
        title: 't',
      });
      const keys: string[] = [];
      fake.hooks.beforeLock = (key) => void keys.push(key);

      await fake.db.transaction((tx) => reviveRefusal(tx as unknown as DbTx, TASK));

      expect(keys).toEqual(want);
    },
  );
});
