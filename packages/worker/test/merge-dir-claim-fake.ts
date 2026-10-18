import { StepSupersededError } from '../src/step-engine/step-ownership.js';

/** The merge-dir claim as an in-memory table, for tests that drive the merge resolver against a
 *  stub db. The SQL itself (stale rules, the task fence, the lock waits) is covered against a real
 *  database by `merge-dir-claim-smoke.ts`. */
export interface MergeDirClaimFake {
  claims: Map<string, { taskId: string; stepId: string; title: string }>;
  /** Sections and claims refuse, as they do once the pass's task is cancelled or past its epoch. */
  fenced: boolean;
  /** Where each release happened, and whether a section was open around it. */
  released: { mergeDir: string; inSection: boolean }[];
  /** A release that fails, as a database error would. */
  releaseError: Error | null;
  sections: number;
  activeSections: number;
  reset(): void;
}

export function createMergeDirClaimFake(): MergeDirClaimFake {
  return {
    claims: new Map(),
    fenced: false,
    released: [],
    releaseError: null,
    sections: 0,
    activeSections: 0,
    reset() {
      this.claims.clear();
      this.fenced = false;
      this.released = [];
      this.releaseError = null;
      this.sections = 0;
      this.activeSections = 0;
    },
  };
}

type Owner = { mergeDir: string; stepId: string; taskId: string };

export const claimFake = createMergeDirClaimFake();

export function mergeDirClaimOverrides(fake: MergeDirClaimFake = claimFake) {
  let open = false;
  return {
    claimMergeDir: async (_db: unknown, owner: Owner) => {
      if (fake.fenced) throw new StepSupersededError(owner.stepId);
      const held = fake.claims.get(owner.mergeDir);
      if (held && held.taskId !== owner.taskId) {
        return { kind: 'held' as const, holder: { id: held.taskId, title: held.title } };
      }
      fake.claims.set(owner.mergeDir, { taskId: owner.taskId, stepId: owner.stepId, title: '' });
      return { kind: 'claimed' as const };
    },
    withMergeDirSection: async <T>(db: unknown, owner: Owner, fn: (tx: unknown) => Promise<T>) => {
      const claim = fake.claims.get(owner.mergeDir);
      if (fake.fenced || claim?.stepId !== owner.stepId)
        throw new StepSupersededError(owner.stepId);
      fake.sections += 1;
      fake.activeSections += 1;
      open = true;
      try {
        return await fn(db);
      } finally {
        open = false;
        fake.activeSections -= 1;
      }
    },
    inMergeDirUnlessClaimed: async <T>(
      db: unknown,
      owner: { mergeDir: string; taskId: string },
      fn: (tx: unknown) => Promise<T>,
    ) => {
      const held = fake.claims.get(owner.mergeDir);
      if (held && held.taskId !== owner.taskId) {
        throw new Error(`task "${held.title}" (${held.taskId}) holds this checkout`);
      }
      return fn(db);
    },
    otherLiveClaim: async (_tx: unknown, mergeDir: string, taskId: string) => {
      const held = fake.claims.get(mergeDir);
      return held && held.taskId !== taskId ? { id: held.taskId, title: held.title } : null;
    },
    releaseMergeDir: async (_tx: unknown, owner: { mergeDir: string; stepId: string }) => {
      if (fake.releaseError) throw fake.releaseError;
      fake.released.push({ mergeDir: owner.mergeDir, inSection: open });
      if (fake.claims.get(owner.mergeDir)?.stepId === owner.stepId) {
        fake.claims.delete(owner.mergeDir);
      }
    },
  };
}
