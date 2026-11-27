import { expect, it } from 'vitest';
import type { Database } from '../src/index.js';
import { withTaskAttachmentsLock, type DbTx } from '../src/task-attachments-lock.js';

it('does not release its caller while a rejected transaction callback still works', async () => {
  let entered!: () => void;
  let resume!: () => void;
  let rejectDriver!: (e: Error) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const continued = new Promise<void>((r) => {
    resume = r;
  });
  let callback: Promise<unknown> | undefined;
  const db = {
    transaction(fn: (tx: DbTx) => Promise<unknown>) {
      callback = fn({ execute: async () => undefined } as unknown as DbTx);
      return new Promise((_, reject) => {
        rejectDriver = reject;
      });
    },
  } as unknown as Database;
  let returned = false;
  const result = withTaskAttachmentsLock(db, 'task', async () => {
    entered();
    await continued;
    return 'finished';
  }).catch((err: unknown) => {
    returned = true;
    return err;
  });
  await started;
  const error = new Error('connection lost');
  rejectDriver(error);
  // Drain the rejection chain without advancing real time. The callback remains at its seam.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  try {
    expect(returned).toBe(false);
  } finally {
    resume();
    await callback;
    await result;
  }
  expect(await result).toBe(error);
});
