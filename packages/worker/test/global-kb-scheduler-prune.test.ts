import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, Set<string>>(),
  removed: [] as string[],
}));

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', () => ({
  Worker: class {},
  Queue: class {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    ids() {
      let ids = h.store.get(this.name);
      if (!ids) h.store.set(this.name, (ids = new Set()));
      return ids;
    }
    upsertJobScheduler = async (id: string) => {
      this.ids().add(id);
    };
    getJobSchedulersCount = async () => this.ids().size;
    getJobSchedulers = async (start = 0, end = -1) =>
      [...this.ids()]
        .slice(start, end < 0 ? undefined : end + 1)
        .map((key) => ({ key, name: 'x' }));
    removeJobScheduler = async (id: string) => {
      h.removed.push(id);
      return this.ids().delete(id);
    };
    close = async () => {};
  },
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...actual,
    logger: { child: () => ({ info: () => {}, error: () => {}, debug: () => {}, warn: () => {} }) },
  };
});

import { QUEUE_NAMES } from '@haive/shared';
import {
  GLOBAL_KB_SCHEDULER_IDS,
  scheduleGlobalKbPurge,
  scheduleGlobalKbReconcile,
} from '../src/queues/global-kb-sync-queue.js';

const PURGE = 'global-kb-purge-archived-repeatable';
const RECONCILE = 'global-kb-reconcile-pending-repeatable';
const OWN = [PURGE, RECONCILE];
const LEGACY = Array.from({ length: 5 }, (_, i) => `legacy-${i}`);
const BOOTS = {
  purge: scheduleGlobalKbPurge,
  reconcile: scheduleGlobalKbReconcile,
};
const ORDERS = [
  ['purge', 'reconcile'],
  ['reconcile', 'purge'],
] as const;

const seed = (...ids: string[]) => h.store.set(QUEUE_NAMES.GLOBAL_KB_SYNC, new Set(ids));
const live = () => [...(h.store.get(QUEUE_NAMES.GLOBAL_KB_SYNC) ?? [])].sort();

beforeEach(() => {
  h.store.clear();
  h.removed.length = 0;
});

describe('global KB scheduler pruning', () => {
  it('holds both owned ids in one exported constant', () => {
    expect([...GLOBAL_KB_SCHEDULER_IDS].sort()).toEqual(OWN);
  });

  describe.each(ORDERS)('%s first, then %s', (first, second) => {
    it('clears the legacy ids and keeps both owned ids on a fresh install', async () => {
      seed(...LEGACY);
      await BOOTS[first]();
      await BOOTS[second]();
      expect(live()).toEqual(OWN);
      expect(h.removed.sort()).toEqual([...LEGACY].sort());
    });

    it('never removes an owned id that a previous boot registered', async () => {
      seed(...OWN, ...LEGACY);
      await BOOTS[first]();
      await BOOTS[second]();
      expect(live()).toEqual(OWN);
      expect(h.removed.filter((id) => OWN.includes(id))).toEqual([]);
    });

    it('removes nothing on a second boot', async () => {
      seed(...LEGACY);
      await BOOTS[first]();
      await BOOTS[second]();
      h.removed.length = 0;
      await BOOTS[first]();
      await BOOTS[second]();
      expect(h.removed).toEqual([]);
      expect(live()).toEqual(OWN);
    });
  });

  it.each(['purge', 'reconcile'] as const)(
    'leaves both owned ids alone when only %s runs',
    async (only) => {
      seed(...OWN, ...LEGACY);
      await BOOTS[only]();
      expect(h.removed.filter((id) => OWN.includes(id))).toEqual([]);
      expect(OWN.every((id) => live().includes(id))).toBe(true);
    },
  );
});
