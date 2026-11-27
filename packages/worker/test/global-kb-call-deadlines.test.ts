import { afterEach, expect, it, vi } from 'vitest';
import type { StepContext } from '@haive/shared/step';
import { configService, CONFIG_KEYS, secretsService, logger } from '@haive/shared';
import { fakeClock, stalledPostgres, until } from '../../../tests/fixtures/global-kb-wire.mjs';

vi.mock('../src/db.js', () => ({ getDb: () => ({}) }));
import { GLOBAL_KB_STEP_DEADLINE_MS } from '../src/step-engine/steps/_global-kb-promote.js';
import { kbAuthorEnrichStep } from '../src/step-engine/steps/kb-author/01-enrich.js';
import { fetchTaskDrafts } from '../src/step-engine/steps/onboarding/09_6_5-global-kb-review.js';
import {
  GLOBAL_KB_SYNC_DEADLINE_MS,
  purgeArchivedGlobalKbEntries,
} from '../src/queues/global-kb-sync-queue.js';

let server: Awaited<ReturnType<typeof stalledPostgres>>;
afterEach(async () => {
  await server?.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['sweep', 'step', 'shutdown'] as const)(
  'bounds %s against an authenticated store holding SQL and releases its socket',
  async (kind) => {
    fakeClock();
    server = await stalledPostgres();
    vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
    vi.spyOn(configService, 'getNumber').mockImplementation(
      async (_key, fallback) => fallback ?? 30,
    );
    vi.spyOn(configService, 'get').mockResolvedValue(null);
    vi.spyOn(configService, 'getFresh').mockImplementation(async (key) =>
      key === CONFIG_KEYS.GLOBAL_KB_MODE ? 'external' : null,
    );
    vi.spyOn(secretsService, 'getFresh').mockResolvedValue(server.url);
    let outcome: unknown = 'pending';
    const controller = new AbortController();
    const opts = { deadlineMs: 20, signal: controller.signal };
    const work =
      kind === 'step'
        ? fetchTaskDrafts(
            {
              db: {} as never,
              taskId: 'task',
              signal: controller.signal,
              logger,
            } as unknown as StepContext,
            opts,
          )
        : purgeArchivedGlobalKbEntries(opts);
    const run = work.then(
      () => {
        outcome = 'resolved';
      },
      (err) => {
        outcome = err;
      },
    );
    await until(() => server.queries.length > 0);
    if (kind === 'shutdown') controller.abort(new Error('shutdown'));
    await vi.advanceTimersByTimeAsync(20);
    if (kind === 'shutdown') expect(outcome).toBe(controller.signal.reason);
    else expect(outcome).toMatchObject({ code: 'GLOBAL_KB_DEADLINE' });
    await run;
    await vi.advanceTimersByTimeAsync(1);
    await until(() => server.open() === 0);
  },
);

it('pins the embedding budgets and leaves room for author work', () => {
  expect(GLOBAL_KB_STEP_DEADLINE_MS).toBe(300_000);
  expect(GLOBAL_KB_STEP_DEADLINE_MS).toBeLessThan(kbAuthorEnrichStep.llm!.timeoutMs!);
  expect(GLOBAL_KB_SYNC_DEADLINE_MS).toBe(60 * 60_000);
});
