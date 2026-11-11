import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  restorePendingKeptMetadata,
  type KeptMetadata,
} from '../../src/project-state/kept-metadata.js';

/** Exercise real restoration and outbox retention underneath each caller's resync seam.
 * The separate outbox has one entry and refuses any clear of a pending/failed restore. */
export async function pendingMetadataControl(conflict: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'pending-metadata-'));
  const path = '.haive-data/plan.json';
  if (conflict) await mkdir(join(root, path), { recursive: true });
  const capture: KeptMetadata = {
    [path]: {
      owner: { uid: process.getuid!(), gid: process.getgid!() },
      mode: 0o600,
    },
  };
  let pending: Record<string, KeptMetadata> | null = { [root]: capture };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ kept: pending }],
        }),
      }),
    }),
    execute: async () => {
      pending = null;
    },
  } as unknown as Database;
  const real = await vi.importActual<typeof import('../../src/project-state/set-aside.js')>(
    '../../src/project-state/set-aside.js',
  );
  return {
    root,
    recover: () => restorePendingKeptMetadata(db, 'metadata-repo', root, real.restoreKeptMetadata),
    pending: () => pending,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
